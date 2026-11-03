// Shared git identity for test fixture repos.
//
// Prefers the operator's ambient git config (green on dev machines where the
// machine-global identity guard only accepts the canonical identity), and
// falls back to a hermetic synthetic identity for neutral homes without any
// git config (green under neutral-home qualification, where no guard exists).
// Fixture repos always set repo-local identity from this helper so tests never
// depend on ambient state beyond this single resolution point.
import { execFileSync } from "node:child_process";

export interface TestGitIdentity {
  name: string;
  email: string;
  /** True when the hermetic synthetic identity was used (neutral home). */
  synthetic: boolean;
}

export const SYNTHETIC_TEST_GIT_IDENTITY = {
  name: "Kontrol Test",
  email: "kontrol-test@example.invalid",
} as const;

export function resolveTestGitIdentity(cwd: string = process.cwd()): TestGitIdentity {
  try {
    const name = execFileSync("git", ["config", "user.name"], { cwd, encoding: "utf8" }).trim();
    const email = execFileSync("git", ["config", "user.email"], { cwd, encoding: "utf8" }).trim();
    if (name.length > 0 && email.length > 0) {
      return { name, email, synthetic: false };
    }
  } catch {
    // No usable ambient config — fall through to the synthetic identity.
  }
  return { ...SYNTHETIC_TEST_GIT_IDENTITY, synthetic: true };
}
