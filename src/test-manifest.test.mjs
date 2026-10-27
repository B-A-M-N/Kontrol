import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// The canonical-chain check must prove EXECUTION, not a mention. A suite that
// is only referenced in a comment, in a self-referencing log line, or in a
// script the chain never runs protects nothing, and the check has to say so.
const checker = fileURLToPath(new URL("../scripts/test-manifest.mjs", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "kontrol-test-manifest-"));

function write(relative, contents) {
  const target = join(fixture, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function reset(files) {
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  for (const [path, contents] of Object.entries(files)) write(path, contents);
}

function runChecker() {
  const result = spawnSync(process.execPath, [checker, "--root", fixture], { encoding: "utf8" });
  return { status: result.status, output: (result.stdout ?? "") + (result.stderr ?? "") };
}

try {
  write("src/executed.test.mjs", "console.log(\"executed\");\n");
  write("src/orphan.test.mjs", "console.log(\"orphan\");\n");
  write("package.json", JSON.stringify({ scripts: { test: "node src/executed.test.mjs" } }, null, 2));

  // A suite the chain never runs is reported.
  const orphan = runChecker();
  assert.equal(orphan.status, 1, "a suite outside the canonical chain fails the check");
  assert.ok(orphan.output.includes("src/orphan.test.mjs"), "the check names the unwired suite");
  assert.ok(!orphan.output.includes("src/executed.test.mjs"), "the check does not name an executed suite");

  // Wiring it makes the check pass.
  write("package.json", JSON.stringify({
    scripts: { test: "node src/executed.test.mjs && node src/orphan.test.mjs" },
  }, null, 2));
  const wired = runChecker();
  assert.equal(wired.status, 0, "a fully wired chain passes the check");
  assert.ok(wired.output.includes("2 test files all executed"), "the check reports the executed count");

  // A mention in a comment is not an execution.
  write("package.json", JSON.stringify({
    scripts: { test: "node src/executed.test.mjs && // node src/orphan.test.mjs" },
  }, null, 2));
  const commented = runChecker();
  assert.equal(commented.status, 1, "a commented-out suite is not executed");
  assert.ok(commented.output.includes("src/orphan.test.mjs"), "the check names the commented-out suite");

  // A shell comment is not a command: "node a.test.mjs # node b.test.mjs"
  // runs nothing after the "#", so the suite named behind it is not
  // executed.
  write("package.json", JSON.stringify({
    scripts: { test: "node src/executed.test.mjs # node src/orphan.test.mjs" },
  }, null, 2));
  const shellComment = runChecker();
  assert.equal(shellComment.status, 1, "a suite named in a shell comment is not executed");
  assert.ok(shellComment.output.includes("src/orphan.test.mjs"), "the check names the suite behind the shell comment");
  assert.ok(!shellComment.output.includes("src/executed.test.mjs"), "the check does not name the suite before the comment");

  // A comment on its own line is not a command either.
  write("package.json", JSON.stringify({
    scripts: { test: "node src/executed.test.mjs\n# node src/orphan.test.mjs\n" },
  }, null, 2));
  const commentLine = runChecker();
  assert.equal(commentLine.status, 1, "a suite named in a comment line is not executed");
  assert.ok(commentLine.output.includes("src/orphan.test.mjs"), "the check names the suite behind the comment line");

  // A "#" inside a quoted word is literal text, not a comment, so the command
  // after it really does run.
  write("package.json", JSON.stringify({
    scripts: { test: "node src/executed.test.mjs" },
  }, null, 2));
  write("src/orphan.test.mjs", "console.log(\"orphan\");\n");
  write("scripts/label.mjs", "console.log(\"#tag\");\n");
  write("package.json", JSON.stringify({
    scripts: { test: "node src/executed.test.mjs && node scripts/label.mjs" },
  }, null, 2));
  const quotedHash = runChecker();
  assert.equal(quotedHash.status, 1, "a quoted hash does not comment out the rest of the line");
  assert.ok(quotedHash.output.includes("src/orphan.test.mjs"), "the check names the suite the quoted hash left unwired");

  // A "#" in the middle of a word is literal text, not a comment start. The
  // interpreter is therefore handed the mangled path "src/exec.test.mjs#...",
  // which names no file it can run, so NEITHER suite ran.
  reset({
    "src/exec.test.mjs": "console.log(\"exec\");\n",
    "src/inner.test.mjs": "console.log(\"inner\");\n",
    "package.json": JSON.stringify({
      scripts: { test: "node src/exec.test.mjs#src/inner.test.mjs" },
    }, null, 2),
  });
  const midWordHash = runChecker();
  assert.equal(midWordHash.status, 1, "a hash inside a word does not comment out the rest of the line");
  assert.ok(midWordHash.output.includes("src/inner.test.mjs"), "the check names the suite behind the mangled path");
  assert.ok(midWordHash.output.includes("src/exec.test.mjs"), "the check names the suite the mangled path names, because it did not run either");

  // An interpreter that evaluates its program inline runs no file. The
  // inline source is JavaScript the interpreter evaluates, not a program it
  // runs, so a path inside it names nothing that was executed.
  reset({
    "src/orphan.test.mjs": "console.log(\"orphan\");\n",
    "package.json": JSON.stringify({
      scripts: { test: "node -e \"src/orphan.test.mjs\"" },
    }, null, 2),
  });
  const inlineProgram = runChecker();
  assert.equal(inlineProgram.status, 1, "an inline program runs no file");
  assert.ok(inlineProgram.output.includes("src/orphan.test.mjs"), "the check names the suite named inside an inline program");

  // A commented-out "npm run" widens neither the closure nor the executed
  // set: the script behind it never runs.
  reset({
    "src/inner.test.mjs": "console.log(\"inner\");\n",
    "package.json": JSON.stringify({
      scripts: { test: "node scripts/runner.mjs # npm run test:inner", "test:inner": "node src/inner.test.mjs" },
    }, null, 2),
    "scripts/runner.mjs": "console.log(\"runner\");\n",
  });
  const commentedNpmRun = runChecker();
  assert.equal(commentedNpmRun.status, 1, "a commented-out npm run does not widen the closure");
  assert.ok(commentedNpmRun.output.includes("src/inner.test.mjs"), "the check names the suite behind the commented-out npm run");

  // A "&&" inside a comment does not split the line either: the command
  // after it is still part of the comment.
  reset({
    "src/exec.test.mjs": "console.log(\"exec\");\n",
    "src/inner.test.mjs": "console.log(\"inner\");\n",
    "package.json": JSON.stringify({
      scripts: { test: "node src/exec.test.mjs # node src/inner.test.mjs && node src/inner.test.mjs" },
    }, null, 2),
  });
  const commentWithSeparator = runChecker();
  assert.equal(commentWithSeparator.status, 1, "a separator inside a comment does not split the command");
  assert.ok(commentWithSeparator.output.includes("src/inner.test.mjs"), "the check names the suite behind the commented separator");

  // A flag value that names a suite is data for the interpreter, not a
  // program it runs: "node --config src/orphan.test.mjs" reads the file as
  // a configuration, it does not execute it.
  reset({
    "src/orphan.test.mjs": "console.log(\"orphan\");\n",
    "package.json": JSON.stringify({
      scripts: { test: "node --config src/orphan.test.mjs" },
    }, null, 2),
  });
  const flagValue = runChecker();
  assert.equal(flagValue.status, 1, "a suite named as a flag value is not executed");
  assert.ok(flagValue.output.includes("src/orphan.test.mjs"), "the check names the suite named as a flag value");

  // An argument after the program belongs to the program, so a path there is
  // data the program reads rather than a program that runs.
  reset({
    "src/executed.test.mjs": "console.log(\"executed\");\n",
    "src/orphan.test.mjs": "console.log(\"orphan\");\n",
    "package.json": JSON.stringify({
      scripts: { test: "node src/executed.test.mjs src/orphan.test.mjs" },
    }, null, 2),
  });
  const trailingArgument = runChecker();
  assert.equal(trailingArgument.status, 1, "a suite named as a program argument is not executed");
  assert.ok(trailingArgument.output.includes("src/orphan.test.mjs"), "the check names the suite passed as an argument");

  // A self-referencing log line is not an execution either.
  write("package.json", JSON.stringify({
    scripts: { test: "node src/executed.test.mjs" },
  }, null, 2));
  write("src/orphan.test.mjs", "console.log(\"src/orphan.test.mjs: all assertions passed\");\n");
  const selfReferencing = runChecker();
  assert.equal(selfReferencing.status, 1, "a self-referencing suite is not executed");
  assert.ok(selfReferencing.output.includes("src/orphan.test.mjs"), "the check names the self-referencing suite");

  // A runner that spawns the suite does execute it.
  write("scripts/runner.mjs", "import { spawnSync } from \"node:child_process\";\nspawnSync(process.execPath, [\"src/orphan.test.mjs\"], { stdio: \"inherit\" });\n");
  write("package.json", JSON.stringify({
    scripts: { test: "node src/executed.test.mjs && node scripts/runner.mjs" },
  }, null, 2));
  const spawned = runChecker();
  assert.equal(spawned.status, 0, "a suite a spawned runner executes counts as executed");

  // A suite that genuinely cannot run stays excluded, with a documented reason.
  write("src/unavailable.test.mjs", "console.log(\"unavailable\");\n");
  write("scripts/test-manifest-allowlist.json", JSON.stringify({
    excluded: { "src/unavailable.test.mjs": "requires an external host" },
  }, null, 2));
  const excluded = runChecker();
  assert.equal(excluded.status, 0, "a documented exclusion is accepted");

  // An exclusion that is no longer needed is itself a failure.
  rmSync(join(fixture, "src/unavailable.test.mjs"));
  write("scripts/test-manifest-allowlist.json", JSON.stringify({
    excluded: { "src/executed.test.mjs": "no longer needed" },
  }, null, 2));
  const stale = runChecker();
  assert.equal(stale.status, 1, "a stale exclusion fails the check");
  assert.ok(stale.output.includes("stale"), "the check says the exclusion is stale");

  // An exclusion for a file that no longer exists is a failure as well.
  write("scripts/test-manifest-allowlist.json", JSON.stringify({
    excluded: { "src/gone.test.mjs": "the suite was deleted" },
  }, null, 2));
  const gone = runChecker();
  assert.equal(gone.status, 1, "an exclusion for a deleted suite fails the check");
  assert.ok(gone.output.includes("no longer exists"), "the check says the exclusion is dead");

  // A script-name array only widens the closure when the runner really RUNS
  // the scripts it names. A runner that merely logs the names proves nothing,
  // so the suite behind the named script stays an orphan.
  const scriptArrayFixture = (runner) => ({
    "src/inner.test.mjs": "console.log(\"inner\");\n",
    "scripts/runner.mjs": runner,
    "package.json": JSON.stringify({
      scripts: { test: "node scripts/runner.mjs", "test:inner": "node src/inner.test.mjs" },
    }, null, 2),
  });

  reset(scriptArrayFixture([
    "import { spawnSync } from \"node:child_process\";",
    "const suites = [\"test:inner\"];",
    "for (const s of suites) console.log(s);",
    "",
  ].join("\n")));
  const loggedArray = runChecker();
  assert.equal(loggedArray.status, 1, "a script array that is only logged does not widen the closure");
  assert.ok(loggedArray.output.includes("src/inner.test.mjs"), "the check names the suite behind the logged script array");

  reset(scriptArrayFixture([
    "import { spawnSync } from \"node:child_process\";",
    "const suites = [\"test:inner\"];",
    "console.log(suites);",
    "",
  ].join("\n")));
  const printedArray = runChecker();
  assert.equal(printedArray.status, 1, "a script array that is only printed does not widen the closure");

  reset(scriptArrayFixture([
    "const suites = [\"test:inner\"];",
    "for (const s of suites) console.log(s);",
    "",
  ].join("\n")));
  const unspawnable = runChecker();
  assert.equal(unspawnable.status, 1, "a runner that cannot spawn at all does not widen the closure");

  // A helper whose name sounds like a spawn but never spawns is not an
  // execution either.
  reset(scriptArrayFixture([
    "import { spawnSync } from \"node:child_process\";",
    "function invokeWebhook(path) { console.log(path); }",
    "invokeWebhook(\"src/inner.test.mjs\");",
    "",
  ].join("\n")));
  const fakeSpawn = runChecker();
  assert.equal(fakeSpawn.status, 1, "a spawn-shaped name that never spawns is not an execution");

  // A script array the runner really spawns does widen the closure.
  reset(scriptArrayFixture([
    "import { spawnSync } from \"node:child_process\";",
    "const suites = [\"test:inner\"];",
    "for (const s of suites) {",
    "  spawnSync(process.execPath, [s], { stdio: \"inherit\" });",
    "}",
    "",
  ].join("\n")));
  const spawnedArray = runChecker();
  assert.equal(spawnedArray.status, 0, "a script array the runner spawns widens the closure");

  // And so does one the runner spawns through a local helper.
  reset(scriptArrayFixture([
    "import { spawnSync } from \"node:child_process\";",
    "function run(name) { spawnSync(process.execPath, [name], { stdio: \"inherit\" }); }",
    "const suites = [\"test:inner\"];",
    "for (const s of suites) { run(s); }",
    "",
  ].join("\n")));
  const helperArray = runChecker();
  assert.equal(helperArray.status, 0, "a script array spawned through a local helper widens the closure");
  // A spawn call quoted inside a log message is DATA, not a call: nothing
  // runs the suite it names.
  reset({
    "src/exec.test.mjs": "console.log(\"exec\");\n",
    "src/inner.test.mjs": "console.log(\"inner\");\n",
    "scripts/runner.mjs": [
      "import { spawnSync } from \"node:child_process\";",
      "console.log(\"run spawnSync(process.execPath, [\\\"src/inner.test.mjs\\\"]) sometime\");",
      "console.log(\'run spawnSync(process.execPath, [\"src/inner.test.mjs\"]) sometime\');",
      "spawnSync(process.execPath, [\"src/exec.test.mjs\"], { stdio: \"inherit\" });",
      "",
    ].join("\n"),
    "package.json": JSON.stringify({ scripts: { test: "node scripts/runner.mjs" } }, null, 2),
  });
  const quotedCall = runChecker();
  assert.equal(quotedCall.status, 1, "a spawn call quoted inside a log message is not an execution");
  assert.ok(quotedCall.output.includes("src/inner.test.mjs"), "the check names the suite quoted in the log message");

  // A suite path carried as DATA - an environment value - names no program
  // either, so it is not an execution.
  reset({
    "src/exec.test.mjs": "console.log(\"exec\");\n",
    "src/inner.test.mjs": "console.log(\"inner\");\n",
    "scripts/runner.mjs": [
      "import { spawnSync } from \"node:child_process\";",
      "spawnSync(process.execPath, [\"src/exec.test.mjs\"], { env: { SUITE: \"src/inner.test.mjs\" } });",
      "",
    ].join("\n"),
    "package.json": JSON.stringify({ scripts: { test: "node scripts/runner.mjs" } }, null, 2),
  });
  const envValue = runChecker();
  assert.equal(envValue.status, 1, "a suite path in an environment value is not an execution");
  assert.ok(envValue.output.includes("src/inner.test.mjs"), "the check names the suite carried in the environment");

  // A spawn helper that lives in an imported local module is real code at
  // runtime, so the closure it drives counts.
  reset({
    "src/inner.test.mjs": "console.log(\"inner\");\n",
    "scripts/helper.mjs": [
      "import { spawnSync } from \"node:child_process\";",
      "export function run(name) { spawnSync(process.execPath, [name], { stdio: \"inherit\" }); }",
      "",
    ].join("\n"),
    "scripts/runner.mjs": [
      "import { run } from \"./helper.mjs\";",
      "const suites = [\"test:inner\"];",
      "for (const s of suites) { run(s); }",
      "",
    ].join("\n"),
    "package.json": JSON.stringify({
      scripts: { test: "node scripts/runner.mjs", "test:inner": "node src/inner.test.mjs" },
    }, null, 2),
  });
  const importedHelper = runChecker();
  assert.equal(importedHelper.status, 0, "a spawn helper imported from a local module widens the closure");

  // A namespace import of node:child_process spawns as well.
  reset({
    "src/exec.test.mjs": "console.log(\"exec\");\n",
    "scripts/runner.mjs": [
      "import * as cp from \"node:child_process\";",
      "cp.spawnSync(process.execPath, [\"src/exec.test.mjs\"], { stdio: \"inherit\" });",
      "",
    ].join("\n"),
    "package.json": JSON.stringify({ scripts: { test: "node scripts/runner.mjs" } }, null, 2),
  });
  const namespaceImport = runChecker();
  assert.equal(namespaceImport.status, 0, "a namespace import of node:child_process widens the closure");

  // A runner that calls a spawn-shaped function but never imports
  // node:child_process cannot start a process at all, so the call proves
  // nothing. This isolates the import rule from the array rules above.
  reset({
    "src/exec.test.mjs": "console.log(\"exec\");\n",
    "scripts/runner.mjs": [
      "function run(name) { spawnSync(process.execPath, [name]); }",
      "run(\"src/exec.test.mjs\");",
      "",
    ].join("\n"),
    "package.json": JSON.stringify({ scripts: { test: "node scripts/runner.mjs" } }, null, 2),
  });
  const noChildProcess = runChecker();
  assert.equal(noChildProcess.status, 1, "a runner that cannot import node:child_process executes nothing");
  assert.ok(noChildProcess.output.includes("src/exec.test.mjs"), "the check names the suite the unreachable spawn named");

  // An interpreter flag the checker cannot classify fails the check. The
  // checker cannot know whether such a flag consumes the argument that
  // follows it, so it cannot know which token is the program, and it must
  // not guess: guessing either misses a suite that really runs or names one
  // that does not.
  reset({
    "src/exec.test.mjs": "console.log(\"exec\");\n",
    "package.json": JSON.stringify({
      scripts: { test: "node --tsconfig cfg.json src/exec.test.mjs" },
    }, null, 2),
  });
  const unclassified = runChecker();
  assert.equal(unclassified.status, 1, "an unclassified interpreter flag fails the check");
  assert.ok(
    unclassified.output.includes("--tsconfig"),
    "the check names the flag it cannot classify",
  );
  assert.ok(
    unclassified.output.includes("INTERPRETER_VALUE_FLAGS"),
    "the check says how to classify the flag",
  );

  // The same flag, classified as one that consumes the next argument, names
  // no program - so the suite behind it is not executed and the check still
  // fails, naming the suite instead of the flag.
  reset({
    "src/exec.test.mjs": "console.log(\"exec\");\n",
    "package.json": JSON.stringify({
      scripts: { test: "node --config src/exec.test.mjs" },
    }, null, 2),
  });
  const classified = runChecker();
  assert.equal(classified.status, 1, "a flag value is data, so the suite behind it is not executed");
  assert.ok(
    classified.output.includes("src/exec.test.mjs"),
    "the check names the suite behind a classified flag value",
  );
  assert.ok(
    !classified.output.includes("cannot classify"),
    "a classified flag is not reported as unclassifiable",
  );

  // A flag that is known not to consume an argument leaves the next token as
  // the program, so the suite runs and the check passes.
  reset({
    "src/exec.test.mjs": "console.log(\"exec\");\n",
    "package.json": JSON.stringify({
      scripts: { test: "node --expose-gc src/exec.test.mjs" },
    }, null, 2),
  });
  const booleanFlag = runChecker();
  assert.equal(booleanFlag.status, 0, "a boolean flag leaves the program where it is");
  assert.ok(booleanFlag.output.includes("1 test files all executed"), "the check reports the executed count");

  // A python module flag names the MODULE as the program, so the path after
  // it is an argument for that program and names no suite.
  reset({
    "src/exec.test.py": "print(\"exec\")\n",
    "package.json": JSON.stringify({
      scripts: { test: "python3 -m py_compile src/exec.test.py" },
    }, null, 2),
  });
  const moduleFlag = runChecker();
  assert.equal(moduleFlag.status, 1, "a python module flag does not execute the path after it");
  assert.ok(
    moduleFlag.output.includes("src/exec.test.py"),
    "the check names the suite the module flag did not run",
  );
  assert.ok(
    !moduleFlag.output.includes("cannot classify"),
    "the python module flag is classified",
  );

} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log("test-manifest.test.mjs: all assertions passed");
