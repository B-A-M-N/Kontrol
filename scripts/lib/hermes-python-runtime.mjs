// Resolution of the Python runtime root for a confined Hermes interpreter.
//
// A relocated CPython (the upstream Hermes runtime keeps its own interpreter
// generation under .hermes-runtime/python/generation-*) can only find its own
// standard library when PYTHONHOME names the runtime root that contains it.
// A system interpreter never needs one, and a wrapper script that merely
// points at the system interpreter (a test fixture, a shim) has no standard
// library of its own: naming its directory as PYTHONHOME would hide the
// interpreter's real one.
import { dirname, join } from "node:path";
import { existsSync, readdirSync, realpathSync } from "node:fs";

const SYSTEM_INTERPRETER_ROOTS = ["/usr", "/bin", "/lib", "/lib64"];

/** True when the path lives under a system interpreter root. */
export function isSystemHermesPath(path) {
  return SYSTEM_INTERPRETER_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * True when the directory holds a real Python standard library, i.e. a
 * lib/pythonX.Y directory that contains os.py.
 */
function containsStandardLibrary(libDirectory) {
  try {
    return readdirSync(libDirectory).some((name) => {
      if (!name.startsWith("python")) return false;
      return existsSync(join(libDirectory, name, "os.py"));
    });
  } catch {
    return false;
  }
}

/**
 * The runtime root of the selected interpreter: the directory that holds the
 * interpreter's own lib/pythonX.Y standard library.
 *
 * Returns undefined when the interpreter is a system interpreter or when its
 * directory holds no real standard library. The caller exports the result as
 * PYTHONHOME only when it is defined.
 */
export function hermesPythonRuntimeRootFor(pythonExecutable) {
  try {
    const resolved = realpathSync(pythonExecutable);
    if (isSystemHermesPath(resolved)) return undefined;
    const root = dirname(dirname(resolved));
    const lib = join(root, "lib");
    if (!existsSync(lib)) return undefined;
    return containsStandardLibrary(lib) ? root : undefined;
  } catch {
    return undefined;
  }
}
