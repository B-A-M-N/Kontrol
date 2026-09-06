/**
 * P1.11: brand contract tests. Brands are erased at runtime (everything is
 * still a string over the wire and in the DB), but the type system must make
 * cross-assigning distinct authority identities a compile error, and the
 * constructors must be the only plain-string entry points.
 */
import assert from "node:assert/strict";
import {
  brandArtifactPath,
  brandBuildId,
  brandDeploymentId,
  brandLaunchGenerationId,
  brandRuntimeLockToken,
  brandWorkSessionId,
  brandWorkspaceId,
  type DeploymentId,
  type RuntimeLockToken,
  type WorkSessionId,
  type WorkspaceId,
} from "./branded.js";

const deploymentId: DeploymentId = brandDeploymentId("deployment-1");
const lockToken: RuntimeLockToken = brandRuntimeLockToken("lock_1");
const workspaceId: WorkspaceId = brandWorkspaceId("workspace-1");
const workSessionId: WorkSessionId = brandWorkSessionId("session-1");

// Brands are erased at runtime: values remain ordinary strings.
assert.equal(typeof deploymentId, "string");
assert.equal(deploymentId, "deployment-1");

// Brands are assignable TO string, so string consumers keep working.
const plain: string = lockToken;
assert.equal(plain, "lock_1");

// Builders return distinct branded identities from the same underlying
// string. TypeScript rejects cross-assignment (verified by the sentinels
// below and by the boundary rejects further down) even though the runtime
// values match.
const sameString = "identity";
const asWorkspace: WorkspaceId = brandWorkspaceId(sameString);
const asWorkSession: WorkSessionId = brandWorkSessionId(sameString);
assert.equal(asWorkspace, asWorkSession);
// A runtime lock token constructor produces RuntimeLockToken, which must not
// satisfy a DeploymentId position (checked by the deployment-literal below).
const wrongDeployment: RuntimeLockToken = brandRuntimeLockToken("lock_2");
// @ts-expect-error a runtime lock token is not a deployment id
const notDeployment: DeploymentId = wrongDeployment;
void notDeployment;
void wrongDeployment;

// Plain strings cannot flow into branded positions without the constructor.
function acceptWorkspace(id: WorkspaceId): string {
  return `ws:${id}`;
}
// @ts-expect-error unbranded strings are rejected at authority boundaries
acceptWorkspace("workspace-raw");
assert.equal(acceptWorkspace(brandWorkspaceId("workspace-2")), "ws:workspace-2");

// All constructors exist and round-trip.
assert.equal(brandBuildId("b"), "b");
assert.equal(brandLaunchGenerationId("g"), "g");
assert.equal(brandArtifactPath("/p"), "/p");

console.log("branded.test.ts: brand contracts hold");
