/**
 * Compatibility facade for the bridge capability modules (P0 refactor).
 *
 * The reviewer/worker control-plane API used to live in this single 3,670-line
 * god module; it now lives in src/bridge/ as capability-oriented registrars
 * over a shared typed context (see src/bridge/register.ts). This file only
 * re-exports the public surface, so existing importers are unaffected.
 */
export { registerBridgeTools } from "./bridge/register.js";
export {
  createContinuationDispatcher,
  runContinuationTick,
  type ContinuationDispatcher,
} from "./bridge/dispatcher.js";
export type { BridgeConfig, LiveWaiterRegistry } from "./bridge/context.js";
