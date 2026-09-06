/**
 * P1.11: branded runtime-authority types. The deployment carries many
 * string-shaped identities (deployment id, lock tokens, launch generation,
 * build id, workspace/work-session ids, MCP session ids, run ids) that were
 * previously plain `string` — making accidental cross-use, e.g. passing a
 * runtime lock token where a deployment lock token belongs, a compile-silent
 * error. Brands are erased at runtime and assignable TO string, so existing
 * string-consuming call sites keep working; only construction requires the
 * explicit `brand*` constructors, which live at the raw-string boundaries
 * (environment parsing, MCP schema output, DB row reads).
 */

declare const brandMarker: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brandMarker]: B };

export type DeploymentId = Brand<string, "DeploymentId">;
export type RuntimeLockToken = Brand<string, "RuntimeLockToken">;
export type DeploymentLockToken = Brand<string, "DeploymentLockToken">;
export type LaunchGenerationId = Brand<string, "LaunchGenerationId">;
export type BuildId = Brand<string, "BuildId">;
export type ArtifactPath = Brand<string, "ArtifactPath">;
export type McpSessionId = Brand<string, "McpSessionId">;
export type LogicalClientId = Brand<string, "LogicalClientId">;
export type ConversationId = Brand<string, "ConversationId">;
/** The opened workspace instance identity (durable rows call it workspace_session_id). */
export type WorkspaceId = Brand<string, "WorkspaceId">;
/** The agent/review workflow identity bound to a workspace. */
export type WorkSessionId = Brand<string, "WorkSessionId">;
export type RunId = Brand<string, "RunId">;

export function brandDeploymentId(value: string): DeploymentId {
  return value as DeploymentId;
}
export function brandRuntimeLockToken(value: string): RuntimeLockToken {
  return value as RuntimeLockToken;
}
export function brandDeploymentLockToken(value: string): DeploymentLockToken {
  return value as DeploymentLockToken;
}
export function brandLaunchGenerationId(value: string): LaunchGenerationId {
  return value as LaunchGenerationId;
}
export function brandBuildId(value: string): BuildId {
  return value as BuildId;
}
export function brandArtifactPath(value: string): ArtifactPath {
  return value as ArtifactPath;
}
export function brandMcpSessionId(value: string): McpSessionId {
  return value as McpSessionId;
}
export function brandLogicalClientId(value: string): LogicalClientId {
  return value as LogicalClientId;
}
export function brandConversationId(value: string): ConversationId {
  return value as ConversationId;
}
export function brandWorkspaceId(value: string): WorkspaceId {
  return value as WorkspaceId;
}
export function brandWorkSessionId(value: string): WorkSessionId {
  return value as WorkSessionId;
}
export function brandRunId(value: string): RunId {
  return value as RunId;
}
