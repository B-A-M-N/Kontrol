/**
 * Single narrowly scoped mapper from parsed server config to mission
 * verification options. Both the manual reviewer path and the supervised
 * ACP path must consume this same mapping so configured sandbox, child
 * environment, toolchain, and executable settings cannot drift between entry
 * points.
 */
import type { ServerConfig } from "../config.js";

export interface MissionVerificationOptions {
  sandbox: boolean;
  childEnvironmentAllowlist: string[];
  verifyToolchainPaths: string[];
  sandboxExecutablePath?: string;
  maxInflight: number;
}

export function missionVerificationOptionsFromConfig(config: ServerConfig): MissionVerificationOptions {
  return {
    sandbox: config.verifySandbox,
    childEnvironmentAllowlist: config.childEnvironmentAllowlist,
    verifyToolchainPaths: config.verifyToolchainPaths,
    sandboxExecutablePath: config.verifySandboxExecutable,
    maxInflight: config.verifyMaxInflight,
  };
}
