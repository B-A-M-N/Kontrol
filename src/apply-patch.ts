import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

export type PatchOperation = "add" | "update" | "delete" | "move";

export interface AppliedPatchFile {
  path: string;
  previousPath?: string;
  operation: PatchOperation;
}

export interface ApplyPatchResult {
  files: AppliedPatchFile[];
  patch: string;
  additions: number;
  removals: number;
}

interface HunkLine {
  kind: "context" | "add" | "remove";
  text: string;
}

interface UpdateHunk {
  lines: HunkLine[];
  changeContext?: string;
  endOfFile?: boolean;
}

type PatchAction =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: UpdateHunk[] };

interface TextFile {
  content: string;
  mode?: number;
}

function patchError(message: string): Error {
  return new Error(`Invalid patch: ${message}`);
}

export function parsePatch(patch: string): PatchAction[] {
  const lines = patchLines(patch);
  if (lines.shift()?.trim() !== "*** Begin Patch") {
    throw patchError("missing *** Begin Patch marker");
  }
  if (lines.pop()?.trim() !== "*** End Patch") {
    throw patchError("missing *** End Patch marker");
  }

  const actions: PatchAction[] = [];
  let index = 0;

  while (index < lines.length) {
    const header = lines[index++].trim();
    if (header === "") continue;

    if (header.startsWith("*** Environment ID: ")) {
      if (!header.slice("*** Environment ID: ".length).trim()) {
        throw patchError("environment id cannot be empty");
      }
      continue;
    }

    if (header.startsWith("*** Add File: ")) {
      const path = header.slice("*** Add File: ".length);
      const content: string[] = [];
      while (index < lines.length && !isTopLevelHeader(lines[index])) {
        const line = lines[index++];
        if (!line.startsWith("+")) {
          throw patchError(`added file line must start with +: ${line}`);
        }
        content.push(line.slice(1));
      }
      if (content.length === 0) throw patchError(`add file for ${path} has no content`);
      actions.push({
        kind: "add",
        path,
        content: `${content.join("\n")}\n`,
      });
      continue;
    }

    if (header.startsWith("*** Delete File: ")) {
      actions.push({ kind: "delete", path: header.slice("*** Delete File: ".length) });
      continue;
    }

    if (header.startsWith("*** Update File: ")) {
      const path = header.slice("*** Update File: ".length);
      let moveTo: string | undefined;
      const hunks: UpdateHunk[] = [];

      if (lines[index]?.trim().startsWith("*** Move to: ")) {
        moveTo = lines[index++].trim().slice("*** Move to: ".length);
      }

      let current: UpdateHunk | undefined;
      const finishCurrent = (): void => {
        if (!current) return;
        if (current.lines.length === 0) throw patchError(`empty update hunk for ${path}`);
        hunks.push(current);
        current = undefined;
      };

      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();
        if (!current && trimmed === "") {
          index++;
          continue;
        }
        if (trimmed === "*** End of File") {
          if (!current) throw patchError(`end-of-file marker without update hunk for ${path}`);
          current.endOfFile = true;
          index++;
          continue;
        }

        if ((!current || !line.startsWith(" ")) && isTopLevelHeader(line)) break;

        if (trimmed.startsWith("@@") && !line.startsWith(" ")) {
          finishCurrent();
          const changeContext = trimmed.slice(2).trim();
          current = { lines: [], changeContext: changeContext || undefined };
          index++;
          continue;
        }

        current ??= { lines: [] };
        index++;
        if (line.startsWith(" ")) current.lines.push({ kind: "context", text: line.slice(1) });
        else if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1) });
        else if (line.startsWith("-")) current.lines.push({ kind: "remove", text: line.slice(1) });
        else if (line === "\\ No newline at end of file") continue;
        else throw patchError(`hunk line must start with space, +, or -: ${line}`);
      }
      finishCurrent();

      if (hunks.length === 0 && !moveTo) {
        throw patchError(`update for ${path} has no hunks or move destination`);
      }
      actions.push({ kind: "update", path, moveTo, hunks });
      continue;
    }

    throw patchError(`unknown action header: ${header}`);
  }

  if (actions.length === 0) throw patchError("contains no file actions");
  return actions;
}

function patchLines(patch: string): string[] {
  let lines = patch.replace(/\r\n/g, "\n").trim().split("\n");
  const first = lines[0]?.trim();
  const last = lines.at(-1)?.trim();
  if (
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    last?.endsWith("EOF") &&
    lines.length >= 4
  ) {
    lines = lines.slice(1, -1);
  }
  return lines;
}

function isTopLevelHeader(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("*** Add File: ") ||
    trimmed.startsWith("*** Delete File: ") ||
    trimmed.startsWith("*** Update File: ") ||
    trimmed.startsWith("*** Environment ID: ")
  );
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveConfinedPath(root: string, input: string): Promise<string> {
  if (!input || input.includes("\0") || isAbsolute(input)) {
    throw patchError(`path must be relative to the workspace: ${input}`);
  }

  const rootPath = await realpath(root);
  const target = resolve(rootPath, input);
  if (!isInside(rootPath, target)) {
    throw patchError(`path escapes the workspace: ${input}`);
  }

  let existing = target;
  while (true) {
    try {
      const resolved = await realpath(existing);
      if (!isInside(rootPath, resolved)) {
        throw patchError(`path resolves outside the workspace: ${input}`);
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }

  return target;
}

function splitFile(content: string): { lines: string[]; eol: string; finalNewline: boolean } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function findSequence(haystack: string[], needle: string[], from: number, endOfFile = false): number {
  if (needle.length === 0) return from;

  const matchAt = (index: number, normalize: (value: string) => string): boolean =>
    needle.every((line, offset) => normalize(haystack[index + offset] ?? "") === normalize(line));

  for (const normalize of [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
  ]) {
    const start = endOfFile ? haystack.length - needle.length : from;
    const end = haystack.length - needle.length;
    for (let index = start; index <= end; index += 1) {
      if (index >= from && matchAt(index, normalize)) return index;
    }
  }

  return -1;
}

function applyHunks(path: string, content: string, hunks: UpdateHunk[]): string {
  const file = splitFile(content);
  const lines = [...file.lines];
  let cursor = 0;

  for (const hunk of hunks) {
    if (hunk.changeContext) {
      const contextIndex = findSequence(lines, [hunk.changeContext], cursor);
      if (contextIndex < 0) {
        throw patchError(`could not find hunk context in ${path}: ${hunk.changeContext}`);
      }
      cursor = contextIndex + 1;
    }

    const oldLines = hunk.lines
      .filter((line) => line.kind !== "add")
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind !== "remove")
      .map((line) => line.text);
    const index = hunk.endOfFile && oldLines.length === 0
      ? lines.length
      : findSequence(lines, oldLines, cursor, hunk.endOfFile);

    if (index < 0) {
      const preview = oldLines.slice(0, 3).join("\n");
      throw patchError(`could not find hunk context in ${path}: ${preview}`);
    }

    lines.splice(index, oldLines.length, ...newLines);
    cursor = index + newLines.length;
  }

  const normalized = `${lines.join("\n")}\n`;
  return file.eol === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function replaceFile(
  temporary: string,
  destination: string,
  destinationExists: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32" || !destinationExists) {
    await rename(temporary, destination);
    return;
  }

  const backup = `${temporary}.original`;
  await rename(destination, backup);
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rename(backup, destination);
    throw error;
  }
  await rm(backup, { force: true });
}

export async function applyPatch(root: string, patch: string): Promise<ApplyPatchResult> {
  const actions = parsePatch(patch);
  const results: AppliedPatchFile[] = [];
  const patches: string[] = [];

  for (const action of actions) {
    if (action.kind === "add") {
      const absolute = await resolveConfinedPath(root, action.path);
      const original = await readOptionalTextFile(absolute, action.path);
      await writeTextFile(absolute, action.content, original?.mode);
      patches.push(unifiedFilePatch(action.path, action.path, original?.content ?? null, action.content));
      results.push({ path: action.path, operation: "add" });
      continue;
    }

    const absolute = await resolveConfinedPath(root, action.path);
    const file = await readRequiredTextFile(absolute, action.path);

    if (action.kind === "delete") {
      await rm(absolute);
      patches.push(unifiedFilePatch(action.path, action.path, file.content, null));
      results.push({ path: action.path, operation: "delete" });
      continue;
    }

    const updated = applyHunks(action.path, file.content, action.hunks);
    if (action.moveTo) {
      const destination = await resolveConfinedPath(root, action.moveTo);
      if (destination !== absolute) await readOptionalTextFile(destination, action.moveTo);
      await writeTextFile(destination, updated, file.mode);
      if (destination !== absolute) await rm(absolute);
      patches.push(unifiedFilePatch(action.path, action.moveTo, file.content, updated));
      results.push({ path: action.moveTo, previousPath: action.path, operation: "move" });
    } else {
      await writeTextFile(absolute, updated, file.mode);
      patches.push(unifiedFilePatch(action.path, action.path, file.content, updated));
      results.push({ path: action.path, operation: "update" });
    }
  }

  const unifiedPatch = patches.filter(Boolean).join("\n");
  const stats = countPatchStats(unifiedPatch);
  return { files: results, patch: unifiedPatch, ...stats };
}

async function readRequiredTextFile(absolute: string, displayPath: string): Promise<TextFile> {
  if (!(await fileExists(absolute))) throw patchError(`file does not exist: ${displayPath}`);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw patchError(`path is not a regular file: ${displayPath}`);
  return { content: await readUtf8Text(absolute, displayPath), mode: metadata.mode };
}

async function readOptionalTextFile(absolute: string, displayPath: string): Promise<TextFile | null> {
  if (!(await fileExists(absolute))) return null;
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw patchError(`path is not a regular file: ${displayPath}`);
  return { content: await readUtf8Text(absolute, displayPath), mode: metadata.mode };
}

async function readUtf8Text(absolute: string, displayPath: string): Promise<string> {
  const bytes = await readFile(absolute);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw patchError(`file is not valid UTF-8 text: ${displayPath}`);
  }
  if (content.includes("\0")) throw patchError(`file appears to be binary: ${displayPath}`);
  return content;
}

async function writeTextFile(destination: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.devspace-patch-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, mode === undefined ? undefined : { mode });
    await replaceFile(temporary, destination, await fileExists(destination));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function fileLines(content: string): string[] {
  if (content.length === 0) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function hunkRange(start: number, count: number): string {
  return count === 0 ? "0,0" : `${start},${count}`;
}

function unifiedFilePatch(
  oldPath: string,
  newPath: string,
  oldContent: string | null,
  newContent: string | null,
): string {
  const oldLines = fileLines(oldContent ?? "");
  const newLines = fileLines(newContent ?? "");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const contextBefore = Math.min(3, prefix);
  const contextAfter = Math.min(3, suffix);
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const before = oldLines.slice(prefix - contextBefore, prefix);
  const after = oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + contextAfter);
  const oldCount = contextBefore + oldChanged.length + contextAfter;
  const newCount = contextBefore + newChanged.length + contextAfter;
  const oldStart = oldContent === null ? 0 : prefix - contextBefore + 1;
  const newStart = newContent === null ? 0 : prefix - contextBefore + 1;
  const displayOld = oldContent === null ? "/dev/null" : `a/${oldPath}`;
  const displayNew = newContent === null ? "/dev/null" : `b/${newPath}`;

  return [
    `diff --git a/${oldPath} b/${newPath}`,
    oldContent === null ? "new file mode 100644" : undefined,
    newContent === null ? "deleted file mode 100644" : undefined,
    `--- ${displayOld}`,
    `+++ ${displayNew}`,
    `@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@`,
    ...before.map((line) => ` ${line}`),
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
    ...after.map((line) => ` ${line}`),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function countPatchStats(patch: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
  }
  return { additions, removals };
}
