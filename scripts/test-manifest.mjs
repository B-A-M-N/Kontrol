#!/usr/bin/env node
/**
 * P1.1: every test file must be EXECUTED by the canonical test chain.
 *
 * Reachability is not execution. A suite that is only mentioned by a script
 * outside the canonical chain protects nothing, because no release gate ever
 * runs it. A mention is not an execution either: a comment, a self-referencing
 * log line, or a bare string does not run anything. A suite counts as executed
 * only when its path reaches a process spawn:
 *
 *   - an interpreter command in a package.json script body
 *     ("node src/x.test.mjs", "tsx src/x.test.ts", "python3 x.test.py"), or
 *   - an executable argument of a call that really starts a process inside
 *     a runner the chain spawns (spawnSync(process.execPath, ["src/x.test.ts"])).
 *
 * "node --check" is a syntax check, not an execution, so it never counts.
 * A shell comment is not a command either: "node a.test.mjs # node b.test.mjs"
 * runs nothing after the "#", so a suite named behind one is not executed.
 *
 * "Executable" means the process receives the path as the program it
 * starts or as an element of its argument vector. A path that is only DATA
 * - quoted in a log message, carried in an environment value or an options
 * object - names no program and runs nothing. A call quoted inside a string
 * literal is not a call at all.
 *
 * The chain is resolved from three sources:
 *   - package.json script bodies ("npm run <script>"),
 *   - runner scripts under scripts/ that those script bodies invoke, and
 *   - the script arrays those runners actually RUN, which is how
 *     scripts/run-runtime-tests.mjs declares the suites it executes.
 *
 * A suite that genuinely cannot run in the canonical chain stays in
 * scripts/test-manifest-allowlist.json with a documented reason. An
 * allowlist entry that is no longer needed is itself a failure: a stale
 * exclusion silently hides the suite it used to protect.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The check runs against the repository by default. --root makes it
// runnable against a fixture tree, which is how its own regression test
// proves that a suite is only counted when it is really invoked.
const rootArgument = process.argv.indexOf("--root");
const root = rootArgument >= 0
  ? resolve(process.argv[rootArgument + 1] ?? ".")
  : fileURLToPath(new URL("..", import.meta.url));
const SELF = "scripts/test-manifest.mjs";
const BACKTICK = String.fromCharCode(96);
const DOUBLE_QUOTE = String.fromCharCode(34);
const SINGLE_QUOTE = String.fromCharCode(39);
const BACKSLASH = String.fromCharCode(92);

const TEST_FILE_PATTERN = /\.test\.(ts|tsx|mjs|js|py)$/;
const TEST_PATH_PATTERN = /^[A-Za-z0-9_.\/-]*\.test\.(tsx|ts|mjs|js|py)$/;
const NPM_RUN_PATTERN = /npm run ([A-Za-z0-9:_-]+)/g;
const TS_RUNNERS = new Set(["tsx", "tsimp", "ts-node", "ts-node-esm"]);
const CHILD_PROCESS_APIS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);
const CALL_PATTERN = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
const ARRAY_PATTERN = /\[([^\[\]]*)\]/g;
const MAX_FLOW_DEPTH = 4;

function collectTestFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(full, acc);
    else if (TEST_FILE_PATTERN.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** The string literals in a fragment, with quotes resolved. */
function stringLiterals(text) {
  const literals = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE || ch === BACKTICK) {
      const quote = ch;
      let value = "";
      index += 1;
      while (index < text.length) {
        const current = text[index];
        if (current === BACKSLASH) {
          value += text[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (current === quote) break;
        value += current;
        index += 1;
      }
      literals.push(value);
      index += 1;
      continue;
    }
    index += 1;
  }
  return literals;
}

/**
 * The ranges the string literals occupy in a fragment.
 *
 * A call inside a string literal is not a call: it is data. A suite path
 * quoted in a log message - or inside a code example - runs nothing, so the
 * scan has to know where the literals are.
 */
function stringRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE || ch === BACKTICK) {
      const quote = ch;
      const start = index;
      index += 1;
      while (index < text.length) {
        const current = text[index];
        if (current === BACKSLASH) {
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      ranges.push([start, index]);
      continue;
    }
    index += 1;
  }
  return ranges;
}

/**
 * The executable part of a fragment. A quoted string is data, not a
 * reference; a template literal contributes only its interpolations. A path
 * that merely sits inside a quoted argument is therefore never mistaken for
 * a value the caller passes.
 */
function codeFragments(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE) {
      const quote = ch;
      index += 1;
      while (index < text.length) {
        const current = text[index];
        if (current === BACKSLASH) {
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (ch === BACKTICK) {
      index += 1;
      while (index < text.length) {
        const current = text[index];
        if (current === BACKSLASH) {
          index += 2;
          continue;
        }
        if (current === BACKTICK) {
          index += 1;
          break;
        }
        if (current === "$" && text[index + 1] === "{") {
          let depth = 1;
          let cursor = index + 2;
          while (cursor < text.length && depth > 0) {
            if (text[cursor] === "{") depth += 1;
            else if (text[cursor] === "}") depth -= 1;
            cursor += 1;
          }
          out += " " + text.slice(index + 2, cursor - 1) + " ";
          index = cursor;
          continue;
        }
        index += 1;
      }
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/** Remove comments so a commented-out path is never read as an execution. */
function stripComments(body) {
  let out = "";
  let index = 0;
  let quote = null;
  let inLine = false;
  let inBlock = false;
  while (index < body.length) {
    const ch = body[index];
    const next = body[index + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      index += 1;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === BACKSLASH) {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
      index += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      index += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      index += 2;
      continue;
    }
    if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE || ch === BACKTICK) {
      quote = ch;
      out += ch;
      index += 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * Remove shell comments from a command body.
 *
 * In POSIX sh a "#" only starts a comment when it begins a word, and the
 * comment runs to the end of the line. A "#" inside a quoted string is
 * literal text, and a "#" inside a word (path#fragment) is literal too. A
 * commented-out command is not a command: naming a suite in a comment runs
 * nothing, so the comment must not widen the chain.
 */
function stripShellComments(body) {
  let out = "";
  let quote = null;
  let wordStart = true;
  let index = 0;
  while (index < body.length) {
    const ch = body[index];
    if (quote) {
      out += ch;
      if (ch === BACKSLASH) {
        out += body[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
      index += 1;
      continue;
    }
    if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE) {
      quote = ch;
      wordStart = false;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === BACKSLASH) {
      out += ch;
      out += body[index + 1] ?? "";
      wordStart = false;
      index += 2;
      continue;
    }
    if (ch === "#" && wordStart) {
      while (index < body.length && body[index] !== "\n") index += 1;
      continue;
    }
    wordStart = /\s/.test(ch) || "&|;()<>".includes(ch);
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * Split a shell command body into the individual commands it runs.
 *
 * The body must already have its shell comments stripped: a comment runs to
 * the end of its line, so the strip has to happen BEFORE the line is split,
 * or a "&&" inside a comment would split a line that never runs.
 */
function splitShellCommands(body) {
  const commands = [];
  let current = "";
  let quote = null;
  let index = 0;
  while (index < body.length) {
    const ch = body[index];
    const next = body[index + 1];
    if (quote) {
      current += ch;
      if (ch === BACKSLASH) {
        current += next ?? "";
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
      index += 1;
      continue;
    }
    if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE) {
      quote = ch;
      current += ch;
      index += 1;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|") || ch === ";" || ch === "\n") {
      commands.push(current);
      current = "";
      index += ch === "&" || ch === "|" ? 2 : 1;
      continue;
    }
    current += ch;
    index += 1;
  }
  commands.push(current);
  return commands;
}

/** Tokenize one shell command, honouring quotes. */
function tokenizeShell(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let index = 0;
  while (index < command.length) {
    const ch = command[index];
    if (quote) {
      if (ch === BACKSLASH) {
        current += command[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        index += 1;
        continue;
      }
      current += ch;
      index += 1;
      continue;
    }
    if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE) {
      quote = ch;
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      index += 1;
      continue;
    }
    if (ch === BACKSLASH && index + 1 < command.length) {
      current += command[index + 1];
      index += 2;
      continue;
    }
    current += ch;
    index += 1;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * The interpreter a shell command invokes, or null when it invokes none.
 * "node --check" parses a file; it never runs it, so it is not an execution.
 */
function interpreterInvocation(tokens) {
  if (tokens.length === 0) return null;
  const head = tokens[0];
  if (head === "node") {
    if (tokens.includes("--check")) return null;
    return { kind: "node", args: tokens.slice(1) };
  }
  if (head === "tsx") return { kind: "tsx", args: tokens.slice(1) };
  if (head === "python" || head === "python3") return { kind: "python", args: tokens.slice(1) };
  if (head === "npx") {
    const rest = tokens.slice(1);
    let index = 0;
    while (index < rest.length && rest[index].startsWith("-")) index += 1;
    if (index < rest.length && TS_RUNNERS.has(rest[index])) {
      return { kind: "tsx", args: rest.slice(index + 1) };
    }
  }
  return null;
}

/**
 * The flags whose value is the argument that follows them.
 *
 * A value flag argument is DATA for the interpreter: "node --import tsx
 * src/x.test.ts" runs src/x.test.ts, and "node --config src/x.test.mjs" reads
 * src/x.test.mjs as a configuration file. A path in that position names no
 * program the interpreter runs.
 */
const INTERPRETER_VALUE_FLAGS = new Set([
  "--import", "-r", "--require", "--loader", "--experimental-loader",
  "--conditions", "--env-file", "--env-file-if-exists", "--openssl-config",
  "--icu-data-dir", "--redirect-warnings", "--max-old-space-size",
  "--max-semi-space-size", "--stack-size", "--stack-trace-limit",
  "--heapsnapshot-signal", "--title", "--test-reporter",
  "--test-reporter-destination", "--config", "--experimental-default-type",
  "--dns-result-order", "--network-family-autoselection-policy",
]);

/** The flags that carry the program inline instead of naming a file. */
const INTERPRETER_INLINE_PROGRAM_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

/**
 * The flags that are known NOT to consume the argument that follows them.
 *
 * A flag that is in neither set is UNKNOWN: the checker cannot know whether
 * it consumes the next token, so it cannot know which token is the program
 * the interpreter runs. Rather than guess - and either miss a suite that
 * really runs or report a suite that does not - the checker reports the flag
 * and fails. Classifying a flag here is what makes the check sound.
 */
/**
 * The flags whose value is the PROGRAM the interpreter runs.
 *
 * "python3 -m py_compile x.py" runs the py_compile module: the module name
 * is the program, and the path after it is an argument FOR that program.
 * The value is therefore not a file the interpreter runs, and it names no
 * suite.
 */
const INTERPRETER_MODULE_FLAGS = new Set(["-m"]);

const INTERPRETER_BOOLEAN_FLAGS = new Set([
  "--expose-gc", "--no-warnings", "--watch",
]);

/**
 * The program an interpreter invocation actually runs.
 *
 * Only the FIRST positional argument is the program. Flags come first, and a
 * flag that consumes a value takes the next token with it. Everything after
 * the program is an argument FOR that program, so a path there is data the
 * program reads rather than a program the interpreter runs. An interpreter
 * that evaluates its program inline runs no file at all.
 */
function interpreterProgram(invocation, unresolved) {
  const args = invocation.args;
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (INTERPRETER_INLINE_PROGRAM_FLAGS.has(token)) return null;
    if (token.startsWith("-")) {
      if (INTERPRETER_VALUE_FLAGS.has(token)) {
        index += 2;
        continue;
      }
      if (INTERPRETER_MODULE_FLAGS.has(token)) {
        // The value is the program: a module name, not a file.
        return args[index + 1] ?? null;
      }
      if (!INTERPRETER_BOOLEAN_FLAGS.has(token)) {
        unresolved.push({ flag: token });
        return null;
      }
      index += 1;
      continue;
    }
    return token;
  }
  return null;
}

/** The balanced block that starts at an opening brace. */
function blockAt(stripped, braceIndex) {
  let depth = 0;
  let index = braceIndex;
  let quote = null;
  while (index < stripped.length) {
    const ch = stripped[index];
    if (quote) {
      if (ch === BACKSLASH) {
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
      index += 1;
      continue;
    }
    if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE || ch === BACKTICK) {
      quote = ch;
      index += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { body: stripped.slice(braceIndex + 1, index), end: index + 1 };
    }
    index += 1;
  }
  return { body: stripped.slice(braceIndex + 1), end: stripped.length };
}

/** Every call in a body, with the code of its arguments. */
function callSites(body) {
  const stripped = stripComments(body);
  const ranges = stringRanges(stripped);
  const sites = [];
  CALL_PATTERN.lastIndex = 0;
  let match;
  while ((match = CALL_PATTERN.exec(stripped)) !== null) {
    // A call quoted inside a string literal is data, not a call.
    const quoted = ranges.some(([from, to]) => match.index >= from && match.index < to);
    if (quoted) continue;
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let index = start;
    let quote = null;
    while (index < stripped.length) {
      const ch = stripped[index];
      if (quote) {
        if (ch === BACKSLASH) {
          index += 2;
          continue;
        }
        if (ch === quote) quote = null;
        index += 1;
        continue;
      }
      if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE || ch === BACKTICK) {
        quote = ch;
        index += 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1;
        index += 1;
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) break;
        index += 1;
        continue;
      }
      index += 1;
    }
    const args = stripped.slice(start + 1, index);
    sites.push({
      name: match[1],
      start,
      end: index,
      raw: args,
      literals: stringLiterals(args),
      code: codeFragments(args),
    });
  }
  return sites;
}

/** Split the argument code of a call on its top-level commas. */
function splitArguments(code) {
  const args = [];
  let current = "";
  let depth = 0;
  for (const ch of code) {
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/**
 * Split the raw argument text of a call on its top-level commas, honouring
 * quotes and nested brackets.
 */
function splitRawArguments(text) {
  const args = [];
  let current = "";
  let depth = 0;
  let quote = null;
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (quote) {
      current += ch;
      if (ch === BACKSLASH) {
        current += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
      index += 1;
      continue;
    }
    if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE || ch === BACKTICK) {
      quote = ch;
      current += ch;
      index += 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += ch;
    index += 1;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/**
 * The value of a fragment that is exactly one string literal.
 *
 * A fragment that is more than a literal - a concatenation, a template,
 * an object - has no single value, so it is not a path the caller passes.
 */
function singleStringLiteral(text) {
  const trimmed = text.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if (quote !== "\"" && quote !== "'") return null;
  if (trimmed[trimmed.length - 1] !== quote) return null;
  const literals = stringLiterals(trimmed);
  if (literals.length !== 1) return null;
  return literals[0];
}

/**
 * The string literals a call hands to a process in an executable position.
 *
 * A path runs a suite only when the process receives it as the program it
 * starts, or as an element of its argument vector. A path inside an
 * options object - an environment value, a working directory, a label -
 * is data the process reads; it names no program. Such a path is not an
 * execution, so it never counts.
 */
function executableLiterals(rawArgs) {
  const literals = [];
  for (const argument of splitRawArguments(rawArgs)) {
    if (argument.length >= 2 && argument.startsWith("[") && argument.endsWith("]")) {
      for (const element of splitRawArguments(argument.slice(1, -1))) {
        const literal = singleStringLiteral(element);
        if (literal !== null) literals.push(literal);
      }
      continue;
    }
    const literal = singleStringLiteral(argument);
    if (literal !== null) literals.push(literal);
  }
  return literals;
}

/** Whether the code of a call site references an identifier by name. */
function referencesIdentifier(code, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("\\b" + escaped + "\\b").test(code);
}

/** The local functions a body declares, with their parameters and body. */
function localFunctions(stripped) {
  const functions = new Map();
  for (const match of stripped.matchAll(/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)/g)) {
    const braceIndex = stripped.indexOf("{", match.index + match[0].length);
    if (braceIndex < 0) continue;
    const block = blockAt(stripped, braceIndex);
    functions.set(match[1], {
      params: match[2].split(",").map((value) => value.trim()).filter(Boolean),
      body: block.body,
    });
  }
  for (const match of stripped.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/g)) {
    const braceIndex = stripped.indexOf("{", match.index + match[0].length - 1);
    if (braceIndex < 0) continue;
    const block = blockAt(stripped, braceIndex);
    functions.set(match[1], {
      params: match[2].split(",").map((value) => value.trim()).filter(Boolean),
      body: block.body,
    });
  }
  return functions;
}

/**
 * Whether a value reaches a process spawn.
 *
 * The value may be passed straight to a spawn-shaped call, or handed to a
 * local function that spawns it. Anything else - a log, an assertion, a
 * function that only reads the value - is not an execution.
 */
function valueReachesSpawn(body, functions, variable, depth = 0) {
  if (depth > MAX_FLOW_DEPTH) return false;
  for (const site of callSites(body)) {
    if (CHILD_PROCESS_APIS.has(site.name)) {
      if (referencesIdentifier(site.code, variable)) return true;
      continue;
    }
    const target = functions.get(site.name);
    if (!target) continue;
    const position = splitArguments(site.code)
      .findIndex((argument) => referencesIdentifier(argument, variable));
    if (position < 0) continue;
    const parameter = target.params[position];
    if (!parameter) continue;
    if (valueReachesSpawn(target.body, functions, parameter, depth + 1)) return true;
  }
  return false;
}

/**
 * The `for (... of ...)` loops in a body. Each entry carries the iterable
 * expression, the loop variables and the body, so a caller can tell an
 * executed loop from a logged one.
 */
/**
 * Whether a call really starts a process.
 *
 * A helper whose name merely sounds like a spawn is not a spawn: the call
 * has to reach the node:child_process API, directly or through a local
 * function that does.
 */
function callActuallySpawns(site, functions, depth = 0) {
  if (depth > MAX_FLOW_DEPTH) return false;
  if (CHILD_PROCESS_APIS.has(site.name)) return true;
  const target = functions.get(site.name);
  if (!target) return false;
  return callSites(target.body).some((inner) => callActuallySpawns(inner, functions, depth + 1));
}

function forOfLoops(stripped) {
  const loops = [];
  for (const match of stripped.matchAll(/\bfor\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let index = open;
    let quote = null;
    while (index < stripped.length) {
      const ch = stripped[index];
      if (quote) {
        if (ch === BACKSLASH) {
          index += 2;
          continue;
        }
        if (ch === quote) quote = null;
        index += 1;
        continue;
      }
      if (ch === DOUBLE_QUOTE || ch === SINGLE_QUOTE || ch === BACKTICK) {
        quote = ch;
        index += 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth += 1;
        index += 1;
        continue;
      }
      if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) break;
        index += 1;
        continue;
      }
      index += 1;
    }
    const header = stripped.slice(open + 1, index);
    const ofMatch = /\bof\b/.exec(header);
    if (!ofMatch) continue;
    const head = header.slice(0, ofMatch.index);
    const variables = [];
    for (const name of head.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
      if (["const", "let", "var", "await", "of", "in"].includes(name)) continue;
      variables.push(name);
    }
    const iterable = header.slice(ofMatch.index + ofMatch[0].length).trim();
    const bodyStart = index + 1;
    const rest = stripped.slice(bodyStart);
    const firstToken = rest.search(/\S/);
    let body = "";
    if (firstToken >= 0 && rest[firstToken] === "{") {
      body = blockAt(stripped, bodyStart + firstToken).body;
    } else {
      const semicolon = stripped.indexOf(";", bodyStart);
      const newline = stripped.indexOf("\n", bodyStart);
      const candidates = [semicolon, newline].filter((value) => value >= 0);
      const end = candidates.length > 0 ? Math.min(...candidates) + 1 : stripped.length;
      body = stripped.slice(bodyStart, end);
    }
    loops.push({ iterable, variables, body });
  }
  return loops;
}

/**
 * Script arrays a runner actually RUNS.
 *
 * An array of package.json script names only declares part of the chain when
 * the runner really executes those scripts. Iterating the array is not enough:
 * a runner that logs the names, or hands them to a function that does
 * nothing, would otherwise widen the closure and mark suites as executed that
 * no release gate ever runs. The array therefore counts only when the script
 * name reaches a process spawn.
 */
function declaredScriptArrays(body, scriptNames, functions) {
  const stripped = stripComments(body);
  const declared = new Set();
  const loops = forOfLoops(stripped);

  for (const match of stripped.matchAll(ARRAY_PATTERN)) {
    const literals = stringLiterals(match[1]);
    if (literals.length === 0) continue;
    if (!literals.every((literal) => scriptNames.has(literal))) continue;

    // The array is the iterable of its own loop.
    let owner = null;
    for (const loop of loops) {
      if (loop.iterable === match[0]) {
        owner = { variables: loop.variables, body: loop.body };
        break;
      }
    }

    // The array is bound to a name that a loop iterates.
    if (!owner) {
      const before = stripped.slice(Math.max(0, match.index - 200), match.index);
      const assigned = /([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*$/.exec(before);
      if (assigned) {
        const name = assigned[1];
        for (const loop of loops) {
          if (loop.iterable !== name) continue;
          owner = { variables: loop.variables, body: loop.body };
          break;
        }
        if (!owner) owner = { variables: [name], body: stripped };
      }
    }

    if (!owner) continue;
    const executed = owner.variables.some((variable) => valueReachesSpawn(owner.body, functions, variable));
    if (!executed) continue;
    for (const literal of literals) declared.add(literal);
  }
  return declared;
}

/**
 * Whether a runner can spawn at all: it imports node:child_process itself,
 * or imports a local module that does. A file that can only read or log
 * cannot execute a suite, whatever its helpers are called.
 */
function localModuleBodies(file, body) {
  const bodies = [];
  const base = dirname(file);
  for (const match of stripComments(body).matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const target = resolve(base, match[1]);
    if (!existsSync(target)) continue;
    try {
      bodies.push(readFileSync(target, "utf8"));
    } catch {
      continue;
    }
  }
  return bodies;
}

function runnerFunctions(file, body) {
  const functions = localFunctions(stripComments(body));
  for (const nested of localModuleBodies(file, body)) {
    for (const [name, target] of localFunctions(stripComments(nested))) {
      if (!functions.has(name)) functions.set(name, target);
    }
  }
  return functions;
}

function canSpawn(file, body) {
  const stripped = stripComments(body);
  if (/from\s+["']node:child_process["']/.test(stripped)) return true;
  for (const nested of localModuleBodies(file, body)) {
    if (/from\s+["']node:child_process["']/.test(stripComments(nested))) return true;
  }
  return false;
}
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

if (typeof scripts.test !== "string") {
  console.error("test-manifest: package.json has no canonical \"test\" script to resolve.");
  process.exit(1);
}

const scriptNames = new Set(Object.keys(scripts));
const closure = new Set(["test"]);
const runnerBodies = new Map();
const executed = new Set();
const unresolvedFlags = [];

function isExistingTestPath(candidate) {
  if (!TEST_PATH_PATTERN.test(candidate)) return false;
  return existsSync(join(root, candidate));
}

function addRunner(candidate) {
  if (runnerBodies.has(candidate)) return false;
  if (!candidate.startsWith("scripts/") || !candidate.endsWith(".mjs")) return false;
  if (candidate === SELF) return false;
  const path = join(root, candidate);
  if (!existsSync(path)) return false;
  runnerBodies.set(candidate, readFileSync(path, "utf8"));
  return true;
}

let changed = true;
while (changed) {
  changed = false;
  for (const name of [...closure]) {
    // The ONE place shell comments are removed. Everything below reads the
    // stripped body, so a command behind a "#" widens neither the closure nor
    // the set of executed suites.
    const body = stripShellComments(scripts[name] ?? "");
    for (const command of splitShellCommands(body)) {
      for (const match of command.matchAll(NPM_RUN_PATTERN)) {
        if (!closure.has(match[1])) {
          closure.add(match[1]);
          changed = true;
        }
      }
      const invocation = interpreterInvocation(tokenizeShell(command));
      if (!invocation) continue;
      const unresolvedBefore = unresolvedFlags.length;
      const program = interpreterProgram(invocation, unresolvedFlags);
      if (program === null) {
        for (let index = unresolvedBefore; index < unresolvedFlags.length; index += 1) {
          unresolvedFlags[index].script = name;
          unresolvedFlags[index].command = command;
        }
        continue;
      }
      if (addRunner(program)) changed = true;
      if (isExistingTestPath(program)) executed.add(program);
    }
  }
  for (const [candidate, body] of runnerBodies) {
    const file = join(root, candidate);
    const functions = runnerFunctions(file, body);
    for (const name of declaredScriptArrays(body, scriptNames, functions)) {
      if (!closure.has(name)) {
        closure.add(name);
        changed = true;
      }
    }
    if (!canSpawn(file, body)) continue;
    for (const site of callSites(body)) {
      if (!callActuallySpawns(site, functions)) continue;
      for (const literal of executableLiterals(site.raw)) {
        if (isExistingTestPath(literal)) executed.add(literal);
      }
    }
  }
}

if (unresolvedFlags.length > 0) {
  console.error("test-manifest: " + unresolvedFlags.length
    + " interpreter flag(s) the checker cannot classify:");
  for (const entry of unresolvedFlags) {
    console.error("  " + entry.flag + " in script '" + entry.script + "': " + entry.command);
  }
  console.error("The checker cannot know whether such a flag consumes the argument that follows it, so it cannot know which token is the program the interpreter runs.");
  console.error("Add the flag to INTERPRETER_VALUE_FLAGS in scripts/test-manifest.mjs when it consumes the next argument, or to INTERPRETER_BOOLEAN_FLAGS when it does not.");
  process.exit(1);
}

const allTests = collectTestFiles(join(root, "src"))
  .concat(collectTestFiles(join(root, "scripts")))
  .map((path) => relative(root, path).split(BACKSLASH).join("/"))
  .sort();

let allowlist = { excluded: {} };
try {
  allowlist = JSON.parse(readFileSync(join(root, "scripts/test-manifest-allowlist.json"), "utf8"));
} catch {
  // No allowlist yet - every test must be wired.
}
const excluded = new Map(Object.entries(allowlist.excluded ?? {}));

const orphans = allTests.filter((path) => {
  if (excluded.has(path)) return false;
  return !executed.has(path);
});

if (orphans.length > 0) {
  console.error("test-manifest: " + orphans.length + " test file(s) are NOT executed by the canonical test chain:");
  for (const path of orphans) {
    console.error("  " + path);
  }
  console.error("Wire each suite into a package.json script the canonical chain reaches, into a runner the chain spawns, or into scripts/test-manifest-allowlist.json with a documented reason.");
  process.exit(1);
}

for (const path of excluded.keys()) {
  if (!allTests.includes(path)) {
    console.error("test-manifest: allowlist entry no longer exists: " + path + " - remove it.");
    process.exit(1);
  }
  if (executed.has(path)) {
    console.error("test-manifest: allowlist entry is stale: " + path + " is executed by the canonical chain - remove the exclusion.");
    process.exit(1);
  }
}

console.log("test-manifest: " + allTests.length + " test files all executed by the canonical chain ("
  + closure.size + " scripts, " + runnerBodies.size + " runners)");
