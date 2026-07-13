// Runtime implementation lives in scripts/lib so shipped adapters can import it
// without depending on the unshipped src/ tree. The TypeScript server imports
// this source-path shim; build:copy-mjs carries it into dist.
export {
  signWorkerToken,
  verifyWorkerToken,
  WorkerTokenError,
  TOKEN_TTL_MS,
} from "../scripts/lib/acp-worker-token.mjs";
