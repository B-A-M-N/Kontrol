import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// The published package ships a declared file list. A shipped script that
// imports a sibling module which is not on that list installs cleanly and
// then fails at runtime with ERR_MODULE_NOT_FOUND, in the clean install, on
// the operator machine. This check resolves every relative import of every
// shipped script against the declared file list, transitively, so a new
// sibling module cannot be added without shipping it.
//
// The scan is a SCANNER, not a pattern. The module specifier of an import is
// whatever string literal follows the import/export KEYWORD, in any quote
// style, on any number of lines. A path that is only DATA - inside a log
// message, or inside a comment - is not an import, so the scanner never
// reports it. A specifier that is not a literal (import(variable)) cannot be
// resolved statically, so it is not reported either.

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = new Set(Array.isArray(pkg.files) ? pkg.files : []);

const shippedScripts = [...declared].filter((entry) =>
  entry.startsWith("scripts/") && entry.endsWith(".mjs") && !entry.includes("*"),
);

assert.ok(shippedScripts.length > 0, "the package declares shipped scripts");

const SINGLE_QUOTE = String.fromCharCode(39);
const DOUBLE_QUOTE = String.fromCharCode(34);
const BACKTICK = String.fromCharCode(96);
const QUOTES = new Set([SINGLE_QUOTE, DOUBLE_QUOTE, BACKTICK]);

function isSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function isIdentifierStart(ch) {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentifierPart(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

// The index just past the closing quote of the string literal at index.
function skipString(text, index) {
  const quote = text[index];
  let cursor = index + 1;
  while (cursor < text.length) {
    const current = text[cursor];
    if (current === "\\") {
      cursor += 2;
      continue;
    }
    cursor += 1;
    if (current === quote) return cursor;
  }
  return cursor;
}

function skipSpace(text, index) {
  let cursor = index;
  while (cursor < text.length && isSpace(text[cursor])) cursor += 1;
  return cursor;
}

// Record the relative module specifier that starts at the given position, if
// any. The position is just after the import/export keyword. A dynamic
// import has an opening parenthesis first; a static import does not. The
// specifier must be a string literal: import(variable) is not statically
// resolvable and is not reported.
function addSpecifier(specifiers, text, from) {
  let cursor = skipSpace(text, from);
  if (text[cursor] === "(") cursor = skipSpace(text, cursor + 1);
  const quote = text[cursor];
  if (!QUOTES.has(quote)) return;
  const end = skipString(text, cursor);
  const literal = text.slice(cursor + 1, end - 1);
  if (literal.startsWith(".")) specifiers.add(literal);
}

// The relative module specifiers a source file imports.
function relativeSpecifiersOf(source) {
  const specifiers = new Set();
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (QUOTES.has(ch)) {
      index = skipString(source, index);
      continue;
    }
    if (isIdentifierStart(ch)) {
      const start = index;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      const word = source.slice(start, index);
      if (word === "from") {
        addSpecifier(specifiers, source, index);
      } else if (word === "import") {
        const cursor = skipSpace(source, index);
        addSpecifier(specifiers, source, cursor);
        if (source[cursor] === "(") index = cursor;
      }
      continue;
    }
    index += 1;
  }
  return specifiers;
}

// A specifier that appears only inside a plain string is data, not an
// import. The literal is assembled from its parts so the fixture stays
// readable without nested quote escapes.
const DQ = String.fromCharCode(34);
const SPEC_IN_DATA = "const msg = " + DQ + "import('./a.mjs')" + DQ + ";";
const scannerCases = [
  ['import x from "./a.mjs";', ["./a.mjs"]],
  ["import x from './a.mjs';", ["./a.mjs"]],
  ['import {\n  a,\n  b,\n} from "./a.mjs";', ["./a.mjs"]],
  ['import "./a.mjs";', ["./a.mjs"]],
  ['const m = await import("./a.mjs");', ["./a.mjs"]],
  ['const m = await import("./a.mjs", { with: { type: "json" } });', ["./a.mjs"]],
  ['const m = import("./a.mjs");', ["./a.mjs"]],
  ['export { a } from "./a.mjs";', ["./a.mjs"]],
  ['export * from "./a.mjs";', ["./a.mjs"]],
  ['import x from "some-package";', []],
  ['import x from "./a.mjs"; // import y from "./b.mjs";', ["./a.mjs"]],
  ['// import x from "./a.mjs";', []],
  ['/* import x from "./a.mjs"; */', []],
  [SPEC_IN_DATA, []],
  ['import x from "./a.mjs"; /* import y from "./b.mjs"; */', ["./a.mjs"]],
  ['const meta = import.meta.url;', []],
];

for (const [source, expected] of scannerCases) {
  const found = [...relativeSpecifiersOf(source)].sort();
  assert.deepEqual(found, expected.slice().sort(),
    "the import scanner must report exactly the expected specifiers in: " + source);
}

const missing = [];
const visited = new Set();

function relativeImportsOf(file) {
  return relativeSpecifiersOf(readFileSync(file, "utf8"));
}

function visit(file, rel, origin) {
  if (visited.has(rel)) return;
  visited.add(rel);
  for (const specifier of relativeImportsOf(file)) {
    const resolved = resolve(dirname(file), specifier);
    const childRel = relative(root, resolved);
    if (!existsSync(resolved)) {
      missing.push(origin + " imports " + specifier + ", which does not exist in the checkout");
      continue;
    }
    if (!declared.has(childRel)) {
      missing.push(origin + " imports " + specifier + ", but " + childRel + " is not in the package \"files\" list");
    }
    // Keep walking: an undeclared module can itself import another one.
    visit(resolved, childRel, childRel);
  }
}

for (const script of shippedScripts) {
  visit(join(root, script), script, script);
}

assert.deepEqual(missing, [],
  "every relative import of a shipped script must be a declared package file:\n" + missing.join("\n"),
);

console.log("package-files-manifest.test.mjs: " + shippedScripts.length
  + " shipped scripts have fully declared relative imports");
