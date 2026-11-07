import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertArtifactContent, verifyArtifactContent } from "./release-integrity.js";

function hashTree(dir: string, hash: ReturnType<typeof createHash>, rel = ""): void {
  const { readdirSync, lstatSync, readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    const relative = join(rel, entry);
    if (relative === "build-meta.json") continue;
    const info = lstatSync(abs);
    if (info.isDirectory()) hashTree(abs, hash, relative);
    else if (info.isFile()) hash.update(relative).update(readFileSync(abs));
  }
}

function makeArtifact() {
  const root = join(tmpdir(), `kontrol-integrity-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "cli.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(root, "sub", "a.js"), "a\n");
  const hash = createHash("sha256").update("kontrol-release-format:4\n");
  hashTree(root, hash);
  const contentSha256 = hash.digest("hex").slice(0, 16);
  writeFileSync(join(root, "build-meta.json"), JSON.stringify({ buildId: "abc123", contentSha256 }));
  return { root, contentSha256 };
}

const good = makeArtifact();
assert.equal(verifyArtifactContent(good.root).ok, true, "untampered artifact verifies");
assertArtifactContent(good.root);

// Tamper one byte after metadata was sealed.
writeFileSync(join(good.root, "sub", "a.js"), "tampered\n");
const bad = verifyArtifactContent(good.root);
assert.equal(bad.ok, false, "tampered artifact fails");
assert.match(bad.reason ?? "", /content hash mismatch/);
assert.throws(() => assertArtifactContent(good.root), /refusing to use unverified release artifact/);

// Symlinks are rejected outright.
const linked = makeArtifact();
symlinkSync(join(linked.root, "cli.js"), join(linked.root, "link.js"));
assert.equal(verifyArtifactContent(linked.root).ok, false, "symlink artifact fails");

console.log("release-integrity.test.ts: all assertions passed");
