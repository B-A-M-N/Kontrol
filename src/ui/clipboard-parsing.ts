/**
 * Clipboard compatibility for ChatGPT's reference-only plain-text format.
 *
 * The marker is meaningful only at the beginning of a non-code line. HTML is
 * converted with DOM semantics so entities, paragraphs, lists, and preformatted
 * blocks retain useful text and indentation. Reference lines are removed only
 * from ordinary HTML flow; code blocks are preserved byte-for-byte.
 */

const REFERENCE_LINE = /^\s*::chatgpt-content-reference\b.*$/i;
const CODE_START = "\uE000";
const CODE_END = "\uE001";

export interface ClipboardReferenceAnalysis {
  hasReferenceMarkers: boolean;
  referenceOnly: boolean;
  unresolved: boolean;
  text: string;
  recoveredFromHtml: boolean;
}

function referenceLines(text: string): string[] {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  let inFence = false;
  const result: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && REFERENCE_LINE.test(line)) result.push(line);
  }
  return result;
}

export function containsChatGptReferenceMarker(text: string): boolean {
  return referenceLines(text).length > 0;
}

function meaningfulLines(text: string): string[] {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !REFERENCE_LINE.test(line));
}

function appendBlock(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function htmlNodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "pre") return `${CODE_START}${element.textContent ?? ""}${CODE_END}\n`;
  const value = [...element.childNodes].map(htmlNodeText).join("");
  if (["p", "div", "section", "article", "header", "footer", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr"].includes(tag)) {
    return appendBlock(value);
  }
  return value;
}

export function htmlToPlainText(html: string): string {
  if (typeof document === "undefined") return "";
  const container = document.createElement("div");
  container.innerHTML = html;
  return htmlNodeText(container)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeFlowReferenceLines(text: string): string {
  return text.split(new RegExp(`(${CODE_START}[\\s\\S]*?${CODE_END})`, "g")).map((part) => {
    if (part.startsWith(CODE_START) && part.endsWith(CODE_END)) return part;
    return part.split("\n").filter((line) => !REFERENCE_LINE.test(line)).join("\n");
  }).join("")
    .replaceAll(CODE_START, "")
    .replaceAll(CODE_END, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function analyzeClipboardReference(plainText: string, htmlText?: string): ClipboardReferenceAnalysis {
  const plain = plainText.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const markers = referenceLines(plain);
  const htmlCandidate = htmlText ? removeFlowReferenceLines(htmlToPlainText(htmlText)) : "";
  const htmlRecovered = markers.length > 0 && meaningfulLines(htmlCandidate).length > 0;
  const nonEmptyPlainLines = plain.split("\n").map((line) => line.trim()).filter(Boolean);
  const referenceOnly = nonEmptyPlainLines.length > 0
    && nonEmptyPlainLines.every((line) => REFERENCE_LINE.test(line));
  return {
    hasReferenceMarkers: markers.length > 0,
    referenceOnly,
    unresolved: markers.length > 0 && !htmlRecovered,
    text: htmlRecovered ? htmlCandidate : plainText,
    recoveredFromHtml: htmlRecovered,
  };
}
