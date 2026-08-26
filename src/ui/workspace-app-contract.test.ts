import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const source = readFileSync(new URL("./workspace-app.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./workspace-app.css", import.meta.url), "utf8");

assert.match(source, /import\("\.\/heavy-payload\.js"\)/, "heavy payload renderer must remain dynamically connected");
assert.match(source, /import\("\.\/review-payload\.js"\)/, "review payload renderer must remain dynamically connected");
assert.match(source, /currentPayload\.update\(/, "mounted payloads must update in place");
assert.match(source, /requestAnimationFrame/, "event-driven renders must be frame-batched");
assert.match(source, /await_workspace_events/, "the WebUI must use one workspace event watcher");
assert.match(source, /reviewEpoch: s\.latestSubmission\.reviewEpoch/, "rehydration must preserve the canonical review epoch");
assert.doesNotMatch(source, /reviewEpoch: Number\(card\?\.summary\?\.reviewEpoch \?\? sc\.reviewEpoch \?\? 0\)/, "review identity must not fabricate epoch zero");
assert.doesNotMatch(source, /diffSha256: String\(card\?\.summary\?\.diffSha256 \?\? sc\.diffSha256 \?\? ""\)/, "review identity must not fabricate an empty diff hash");
assert.match(source, /Needs your input/, "open agent messages must have a visible high-priority surface");
assert.match(source, /Rich renderer failed/, "plain text is only a rich-renderer failure fallback");

const workSessionStart = source.indexOf("function renderWorkSessionView");
const workSessionEnd = source.indexOf("function createWorkSessionDom");
assert.ok(workSessionStart >= 0 && workSessionEnd > workSessionStart);
assert.doesNotMatch(source.slice(workSessionStart, workSessionEnd), /appRoot\.replaceChildren\(main\)/, "work-session telemetry must not rebuild the whole DOM");

const documentRules = css.slice(css.indexOf("html,"), css.indexOf(".shell"));
assert.doesNotMatch(documentRules, /overflow:\s*hidden/, "the document must be allowed to scroll");
assert.match(css, /\.agent-activity[\s\S]*max-height/, "activity must have bounded scrolling");
assert.match(css, /\.review-payload[\s\S]*overflow:\s*auto/, "review payloads must have bounded scrolling");

const builtPath = new URL("../../dist/ui/workspace-app.html", import.meta.url);
if (existsSync(builtPath)) {
  const built = readFileSync(builtPath, "utf8");
  assert.match(built, /mountHeavyPayload/, "built app must contain the rich file renderer");
  assert.match(built, /mountReviewPayload/, "built app must contain the rich review renderer");
  assert.match(built, /FileStream|FileDiff/, "built app must contain Pierre rendering primitives");
  assert.ok(Buffer.byteLength(built, "utf8") < 12 * 1024 * 1024, "workspace app exceeded the startup resource budget");
}

console.log("workspace-app-contract.test.ts: all assertions passed");
