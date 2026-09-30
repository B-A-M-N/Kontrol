import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  analyzeClipboardReference,
  containsChatGptReferenceMarker,
  htmlToPlainText,
} from "./clipboard-parsing.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });

assert.equal(containsChatGptReferenceMarker("ordinary task\nconst marker = '::chatgpt-content-reference::';"), false);
const referenceOnly = analyzeClipboardReference("::chatgpt-content-reference::");
assert.equal(referenceOnly.unresolved, true);
assert.equal(referenceOnly.referenceOnly, true);

const mixed = analyzeClipboardReference("Please apply this\n::chatgpt-content-reference::");
assert.equal(mixed.unresolved, true, "mixed plain text and an unresolved marker must remain blocked");
assert.equal(mixed.text, "Please apply this\n::chatgpt-content-reference::");

const recovered = analyzeClipboardReference(
  "::chatgpt-content-reference::",
  "<p>Recovered paragraph</p><pre><code>  const x = 1;\n::chatgpt-content-reference::</code></pre>",
);
assert.equal(recovered.recoveredFromHtml, true);
assert.equal(recovered.unresolved, false);
assert.match(recovered.text, /Recovered paragraph/);
assert.match(recovered.text, /  const x = 1;/);
assert.match(recovered.text, /::chatgpt-content-reference::/, "reference-looking code must not be stripped");

assert.equal(htmlToPlainText("<p>one</p><p>two</p>"), "one\ntwo");
console.log("clipboard-parsing.test.ts: all assertions passed");
