import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesPythonRuntimeRootFor, isSystemHermesPath } from "../scripts/lib/hermes-python-runtime.mjs";

const root = mkdtempSync(join(tmpdir(), "hermes-python-runtime-"));
try {
  // A relocated runtime whose lib/pythonX.Y holds a real standard library.
  const relocated = join(root, "relocated");
  mkdirSync(join(relocated, "bin"), { recursive: true });
  mkdirSync(join(relocated, "lib", "python3.11"), { recursive: true });
  writeFileSync(join(relocated, "lib", "python3.11", "os.py"), "# stdlib marker\n");
  const relocatedPython = join(relocated, "bin", "python3.11");
  writeFileSync(relocatedPython, "#!/bin/sh\nexec true\n");
  chmodSync(relocatedPython, 0o755);
  assert.equal(
    hermesPythonRuntimeRootFor(relocatedPython),
    relocated,
    "a relocated interpreter with its own standard library resolves its runtime root",
  );

  // A runtime root whose python directory has no os.py is not a standard
  // library, so it must not be named as PYTHONHOME.
  const noStdlib = join(root, "no-stdlib");
  mkdirSync(join(noStdlib, "bin"), { recursive: true });
  mkdirSync(join(noStdlib, "lib", "python3.10"), { recursive: true });
  const noStdlibPython = join(noStdlib, "bin", "python");
  writeFileSync(noStdlibPython, "#!/bin/sh\nexec true\n");
  chmodSync(noStdlibPython, 0o755);
  assert.equal(
    hermesPythonRuntimeRootFor(noStdlibPython),
    undefined,
    "a directory without a real standard library is never named as PYTHONHOME",
  );

  // A wrapper script that points at the system interpreter has no standard
  // library of its own, so it must not get a PYTHONHOME either.
  const wrapper = join(root, "wrapper");
  mkdirSync(join(wrapper, "bin"), { recursive: true });
  const wrapperPython = join(wrapper, "bin", "python");
  writeFileSync(wrapperPython, "#!/bin/sh\nexec /usr/bin/python3 \"$@\"\n");
  chmodSync(wrapperPython, 0o755);
  assert.equal(
    hermesPythonRuntimeRootFor(wrapperPython),
    undefined,
    "a wrapper script that points at the system interpreter gets no PYTHONHOME",
  );

  // A symlinked interpreter resolves through to its real target, so the root
  // comes from the target rather than from the link own directory.
  const linked = join(root, "linked");
  mkdirSync(join(linked, "bin"), { recursive: true });
  const linkedPython = join(linked, "bin", "python");
  symlinkSync(relocatedPython, linkedPython);
  assert.equal(
    hermesPythonRuntimeRootFor(linkedPython),
    relocated,
    "a symlinked interpreter resolves its runtime root through the real target",
  );

  assert.equal(hermesPythonRuntimeRootFor("/nonexistent/python"), undefined,
    "a missing interpreter has no runtime root");
  assert.equal(hermesPythonRuntimeRootFor("/usr/bin/python3"), undefined,
    "a system interpreter never needs a PYTHONHOME");
  assert.equal(isSystemHermesPath("/usr/bin/python3"), true);
  assert.equal(isSystemHermesPath("/opt/kontrol/hermes-bin/python"), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("hermes-python-runtime.test.mjs: all assertions passed");
