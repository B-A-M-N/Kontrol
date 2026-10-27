/** Narrow argv profiles accepted by unattended scheduled verification. */
export interface ScheduledVerificationCommand {
  command: string;
  executable: string;
  args: string[];
  profile: "python-pytest" | "rust-cargo-test" | "npm-test" | "go-test" | "make-test" | "vitest-run" | "jest-run" | "tsc-check" | "ruff-check";
}

const SHELL_SYNTAX = /[;&|><`$(){}%!'"^\n\r]/;
const SAFE_CRATE_OR_TEST_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SAFE_RELATIVE_TEST_PATH = /^[A-Za-z0-9_./*:-]{1,240}$/;

function validateCommon(command: string): string[] {
  const value = command.trim();
  if (!value || value.length > 1_024 || SHELL_SYNTAX.test(value)) {
    throw new Error("Scheduled verification command is not permitted by an approved execution profile.");
  }
  const tokens = value.split(/\s+/);
  if (tokens.some((token) => token.startsWith("/")
    || token.replace(/\\/g, "/").split("/").some((part) => part === ".."))) {
    throw new Error("Scheduled verification arguments may not escape the submitted workspace.");
  }
  return tokens;
}

function validatePytestArgs(args: string[]): void {
  const valueFlags = new Set(["-k", "-m"]);
  const flags = new Set(["-q", "-v", "-ra", "-x", "--strict-markers", "--strict-config", "--disable-warnings", "--tb=short", "--maxfail=1"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (flags.has(arg)) continue;
    if (valueFlags.has(arg)) {
      const value = args[index + 1];
      if (!value || !/^[A-Za-z0-9_./:-]{1,120}$/.test(value)) {
        throw new Error(`Scheduled pytest profile requires a simple value after ${arg}.`);
      }
      index += 1;
      continue;
    }
    if (!SAFE_RELATIVE_TEST_PATH.test(arg) || arg.startsWith("-")) {
      throw new Error(`Scheduled pytest profile does not permit argument ${JSON.stringify(arg)}.`);
    }
  }
}

function validateCargoTestArgs(args: string[]): void {
  const flags = new Set(["--workspace", "--all-targets", "--all-features", "--locked", "--offline", "--lib", "--bins", "--examples", "--tests", "--benches", "--doc", "--quiet"]);
  const valueFlags = new Set(["-p", "--package", "--test", "--target"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (flags.has(arg)) continue;
    if (valueFlags.has(arg)) {
      const value = args[index + 1];
      if (!value || !SAFE_CRATE_OR_TEST_NAME.test(value)) {
        throw new Error(`Scheduled cargo test profile requires a simple value after ${arg}.`);
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--features=")) {
      const features = arg.slice("--features=".length);
      if (!/^[A-Za-z0-9_,.-]{1,200}$/.test(features)) throw new Error("Scheduled cargo test profile has invalid feature names.");
      continue;
    }
    throw new Error(`Scheduled cargo test profile does not permit argument ${JSON.stringify(arg)}.`);
  }
}

function exact(command: string, executable: string, args: string[], profile: ScheduledVerificationCommand["profile"]): ScheduledVerificationCommand {
  return { command: command.trim(), executable, args, profile };
}

export function parseScheduledVerificationCommand(command: string): ScheduledVerificationCommand {
  const tokens = validateCommon(command);
  const [executable, ...args] = tokens;

  if (executable === "python3" || executable === "pytest") {
    const pytestArgs = executable === "python3"
      ? args[0] === "-m" && args[1] === "pytest" ? args.slice(2) : undefined
      : args;
    if (!pytestArgs) throw new Error("The Python profile only permits `python3 -m pytest`.");
    validatePytestArgs(pytestArgs);
    return exact(command, executable, args, "python-pytest");
  }

  if (executable === "cargo") {
    if (args[0] !== "test") throw new Error("The Rust profile only permits `cargo test`.");
    validateCargoTestArgs(args.slice(1));
    return exact(command, executable, args, "rust-cargo-test");
  }

  if (executable === "npm" && (args.join(" ") === "test" || args.join(" ") === "run test")) {
    return exact(command, executable, args, "npm-test");
  }
  if (executable === "go" && args[0] === "test" && args.slice(1).every((arg) => arg === "./..." || SAFE_RELATIVE_TEST_PATH.test(arg))) {
    return exact(command, executable, args, "go-test");
  }
  if (executable === "make" && args.length === 1 && ["test", "check"].includes(args[0]!)) {
    return exact(command, executable, args, "make-test");
  }
  if (executable === "vitest" && args[0] === "run" && args.slice(1).every((arg) => SAFE_RELATIVE_TEST_PATH.test(arg))) {
    return exact(command, executable, args, "vitest-run");
  }
  if (executable === "jest" && (args.length === 1 && args[0] === "--runInBand"
    || args.length === 2 && args[0] === "--runInBand" && SAFE_RELATIVE_TEST_PATH.test(args[1]!))) {
    return exact(command, executable, args, "jest-run");
  }
  if (executable === "tsc" && args.length === 1 && args[0] === "--noEmit") {
    return exact(command, executable, args, "tsc-check");
  }
  if (executable === "ruff" && args[0] === "check" && args.slice(1).every((arg) => SAFE_RELATIVE_TEST_PATH.test(arg))) {
    return exact(command, executable, args, "ruff-check");
  }
  throw new Error("Scheduled verification command does not match an approved Python, Rust, or test-runner profile.");
}
