import { constants } from "node:fs";
import { access as fsAccess, glob as fsGlob, readFile as fsReadFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { matchesGlob, resolve as resolvePath } from "node:path";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashToolInput,
  type EditToolInput,
  type EditToolDetails,
  type FindToolInput,
  type GrepToolInput,
  type LsToolInput,
  type ReadToolInput,
  type WriteToolInput,
  type AgentToolResult,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";
import { buildChildEnvironment } from "./process-environment.js";
import { resolveAllowedPath, resolveAllowedPathCanonical } from "./roots.js";

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
  /**
   * Extra environment variable names a workspace may pass through to child
   * processes.  Sensitive keys are filtered unconditionally by
   * `buildChildEnvironment`, so this can only widen, never deepen, access.
   */
  childEnvironmentAllowlist?: string[];
}

function toMcpContent(result: AgentToolResult<unknown>): McpContent[] {
  return result.content.map((content) => {
    if (content.type === "text") {
      return { type: "text", text: content.text };
    }

    return {
      type: "image",
      data: content.data,
      mimeType: content.mimeType,
    };
  });
}

function formatToolError(error: unknown): McpContent[] {
  const message = error instanceof Error ? error.message : String(error);
  return [{ type: "text", text: message }];
}

async function runTool<TInput, TDetails = unknown>(
  execute: (input: TInput) => Promise<AgentToolResult<TDetails>>,
  input: TInput,
  context: ToolContext,
): Promise<ToolResponse<TDetails>> {
  try {
    const result = await execute(input);
    return {
      content: toMcpContent(result),
      details: result.details,
    };
  } catch (error) {
    return { content: formatToolError(error), isError: true };
  }
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = await resolveAllowedPathCanonical(input.path, context.cwd, context.readRoots ?? [context.root], context.root);
  const tool = createReadTool(context.cwd);

  return runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
}

/** Read displayed bytes and their complete-file version from one observation. */
export async function readFileSnapshotTool(
  input: ReadToolInput,
  context: ToolContext,
): Promise<ToolResponse & { contentSha256?: string }> {
  const path = await resolveAllowedPathCanonical(input.path, context.cwd, context.readRoots ?? [context.root], context.root);
  let observedBytes: Buffer | undefined;
  const tool = createReadTool(context.cwd, {
    operations: {
      access: async (absolutePath) => fsAccess(absolutePath, constants.R_OK),
      detectImageMimeType: detectSupportedImageMimeTypeFromFile,
      readFile: async (absolutePath) => {
        const canonical = await resolveAllowedPathCanonical(absolutePath, context.cwd, context.readRoots ?? [context.root], context.root);
        observedBytes = await fsReadFile(canonical);
        return observedBytes;
      },
    },
  });
  const response = await runTool((params) => tool.execute("read_file", params), {
    path,
    offset: input.offset,
    limit: input.limit,
  }, context);
  return {
    ...response,
    contentSha256: observedBytes
      ? createHash("sha256").update(observedBytes).digest("hex")
      : undefined,
  };
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  const path = await resolveAllowedPathCanonical(input.path, context.cwd, [context.root], context.root);
  const tool = createWriteTool(context.cwd);

  return runTool((params) => tool.execute("write_file", params), {
    path,
    content: input.content,
  }, context);
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  const path = await resolveAllowedPathCanonical(input.path, context.cwd, [context.root], context.root);
  const tool = createEditTool(context.cwd);

  return runTool((params) => tool.execute("edit_file", params), {
    path,
    edits: input.edits,
  }, context);
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) await resolveAllowedPathCanonical(input.path, context.cwd, [context.root], context.root);
  const tool = createGrepTool(context.cwd);

  return runTool((params) => tool.execute("grep_files", params), input, context);
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) await resolveAllowedPathCanonical(input.path, context.cwd, [context.root], context.root);
  const tool = createFindTool(context.cwd);
  const result = await runTool((params) => tool.execute("find_files", params), input, context);
  const text = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
  if (!result.isError || (!text.includes("--no-require-git") && !text.includes("fd is not available"))) return result;

  // Pi's default fd integration uses --no-require-git for workspaces outside
  // a Git checkout. Older system fd builds reject the option, so retain the
  // inspection tool contract with Node's built-in globber in that case.
  const compatibleTool = createFindTool(context.cwd, {
    operations: {
      exists: async (path) => {
        try {
          await fsAccess(path, constants.R_OK);
          return true;
        } catch {
          return false;
        }
      },
      glob: async (pattern, cwd, options) => {
        const hasPath = pattern.includes("/");
        const effectivePattern = !hasPath
          ? `**/${pattern}`
          : (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**" ? `**/${pattern}` : pattern);
        const matches: string[] = [];
        for await (const match of fsGlob(effectivePattern, { cwd, exclude: options.ignore })) {
          if (options.ignore.some((ignoredPattern) => matchesGlob(match, ignoredPattern))) continue;
          matches.push(resolvePath(cwd, match));
          if (matches.length >= options.limit) break;
        }
        return matches.sort();
      },
    },
  });
  return runTool((params) => compatibleTool.execute("find_files", params), input, context);
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  if (input.path) await resolveAllowedPathCanonical(input.path, context.cwd, [context.root], context.root);
  const tool = createLsTool(context.cwd);

  return runTool((params) => tool.execute("list_directory", params), input, context);
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  // Shell output is project-controlled, so it must never observe the server
  // environment wholesale — replace it with the sanitized child environment.
  // The hook ignores Pi's inherited `env` entirely rather than trusting it.
  const shellEnvironment = buildChildEnvironment({
    additionalKeys: context.childEnvironmentAllowlist,
  });
  const tool = createBashTool(context.cwd, {
    exposeSessionEnvironment: false,
    spawnHook: ({ command, cwd }) => ({ command, cwd, env: shellEnvironment }),
  });
  const timeout = input.timeout === undefined ? 30 : Math.min(input.timeout, 300);

  return runTool((params) => tool.execute("run_shell", params), {
    command: input.command,
    timeout,
  }, context);
}
