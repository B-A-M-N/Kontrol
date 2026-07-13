import assert from "node:assert/strict";

let pass = 0;
const t = (name, fn) => { try { fn(); console.log("  PASS:", name); pass++; } catch (e) { throw new Error(`FAIL: ${name} -> ${e.message}`); } };

// Re-declare the pure helper exactly as it lives in scripts/acp-crush-adapter.mjs
// (kept in sync manually; tests it in isolation so the adapter's module-load
// env-secret gate doesn't abort the import).
function extractTask(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) {
    throw new Error("ACP input must be a string or message array");
  }
  return input
    .flatMap((message) =>
      Array.isArray(message?.parts)
        ? message.parts
            .map((part) => (typeof part?.content === "string" ? part.content : ""))
            .filter(Boolean)
        : [],
    )
    .join("\n");
}

console.log("== extractTask (adapter task parser) ==");

// The exact shape callRemoteAgent() sends into the adapter.
const ACP_INPUT = [
  { role: "user", parts: [{ content_type: "text/plain", content: "Do the thing\nwith the thing" }] },
];

t("ACP array shape parses to task text", () => {
  assert.equal(extractTask(ACP_INPUT), "Do the thing\nwith the thing");
});

t("plain string passes through", () => {
  assert.equal(extractTask("plain task"), "plain task");
});

t("multiple messages concatenate", () => {
  assert.equal(
    extractTask([
      { parts: [{ content: "a" }, { content: "b" }] },
      { parts: [{ content: "c" }] },
    ]),
    "a\nb\nc",
  );
});

t("non-string parts are ignored", () => {
  assert.equal(
    extractTask([{ parts: [{ content: "keep" }, { content: 123 }, {}] }]),
    "keep",
  );
});

t("empty array is empty string", () => {
  assert.equal(extractTask([]), "");
});

console.log(`\nextractTask: ${pass} passed\n`);
