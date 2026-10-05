import { createHash } from "node:crypto";
import { normalizeWorkspaceSnapshotIdentity } from "../review-checkpoints.js";
import type { MissionContractInput, MissionCriterionInput } from "../mission-ledger.js";

export interface StoredMissionContract {
  workSessionId: string;
  workspaceSessionId: string;
  objective: string;
  desiredOutcome: string;
  constraints: unknown[];
  nonGoals: string[];
  userLockedFields: string[];
  supervisorInstructions?: string;
  baselineKind?: MissionContractInput["baselineKind"];
  baselineRef?: string;
  maxCorrectionRounds: number;
  finalVerification: string[];
  reviewCoverage: string[];
}

export interface StoredMissionCriterion {
  description: string;
  priority: string;
  verificationType?: string;
  verificationCommand?: string;
  runtimeProbe?: MissionCriterionInput["runtimeProbe"];
  affectedAreas: string[];
  dependsOnCriterionIds: string[];
  verificationGroup?: string;
  verificationScope?: string;
  finalOnly: boolean;
  mutatesWorkspace: boolean;
  commandVersion?: string;
}

export function validateMissionCriterionContract(criteria: MissionCriterionInput[]): void {
  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (criterion.id) {
      if (ids.has(criterion.id)) throw new Error(`Duplicate mission criterion id: ${criterion.id}`);
      ids.add(criterion.id);
    }
    if (criterion.dependsOnCriterionIds?.length && !criterion.id) throw new Error("A criterion with dependencies must have a stable id.");
  }
  for (const criterion of criteria) {
    for (const dependency of criterion.dependsOnCriterionIds ?? []) {
      if (!ids.has(dependency)) throw new Error(`Criterion ${criterion.id ?? "(generated)"} depends on unknown criterion ${dependency}.`);
      if (dependency === criterion.id) throw new Error(`Criterion ${criterion.id} cannot depend on itself.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(criteria.filter((criterion): criterion is MissionCriterionInput & { id: string } => Boolean(criterion.id)).map((criterion) => [criterion.id, criterion]));
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Mission criterion dependency cycle detected at ${id}.`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOnCriterionIds ?? []) walk(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) walk(id);

  for (const criterion of criteria) {
    const type = criterion.verificationType ?? (criterion.verificationCommand ? "test" : "manual_review");
    if (type === "test" && !criterion.verificationCommand?.trim()) {
      throw new Error(`Test criterion ${criterion.id ?? criterion.description} requires a verificationCommand.`);
    }
    if (type === "runtime_behavior" && !criterion.runtimeProbe) {
      throw new Error(`Runtime behavior criterion ${criterion.id ?? criterion.description} requires a runtimeProbe.`);
    }
    if (type !== "test" && criterion.verificationCommand) {
      throw new Error(`Criterion ${criterion.id ?? criterion.description} has a verificationCommand but verificationType is ${type}.`);
    }
    if (type !== "runtime_behavior" && criterion.runtimeProbe) {
      throw new Error(`Criterion ${criterion.id ?? criterion.description} declares a runtimeProbe but is not runtime_behavior.`);
    }
  }
}

export function fingerprintMissionContract(input: MissionContractInput, criteria: MissionCriterionInput[]): string {
  const baselineIdentity = normalizeWorkspaceSnapshotIdentity({
    snapshotKind: input.baselineKind,
    snapshotRef: input.baselineRef,
    snapshotCommit: input.baselineCommit,
  });
  const normalizedCriteria = criteria.map((criterion) => ({
    description: criterion.description,
    priority: criterion.priority ?? "required",
    verificationType: criterion.verificationType ?? (criterion.verificationCommand ? "test" : "manual_review"),
    verificationCommand: criterion.verificationCommand ?? null,
    runtimeProbe: criterion.runtimeProbe ?? null,
    affectedAreas: criterion.affectedAreas ?? [],
    dependsOnCriterionIds: criterion.dependsOnCriterionIds ?? [],
    verificationGroup: criterion.verificationGroup ?? null,
    verificationScope: criterion.verificationScope ?? "full",
    finalOnly: criterion.finalOnly ?? false,
    mutatesWorkspace: criterion.mutatesWorkspace ?? false,
    commandVersion: criterion.commandVersion ?? null,
  }));
  const payload = {
    workSessionId: input.workSessionId,
    workspaceSessionId: input.workspaceSessionId,
    objective: input.objective,
    desiredOutcome: input.desiredOutcome ?? input.objective,
    constraints: input.constraints ?? [],
    nonGoals: input.nonGoals ?? [],
    userLockedFields: input.userLockedFields ?? ["objective", "desiredOutcome", "constraints", "nonGoals"],
    supervisorInstructions: input.supervisorInstructions ?? null,
    baselineKind: baselineIdentity?.kind ?? null,
    baselineRef: baselineIdentity?.ref ?? null,
    maxCorrectionRounds: input.maxCorrectionRounds ?? 5,
    finalVerification: input.finalVerification ?? [],
    reviewCoverage: input.reviewCoverage ?? [],
    acceptanceCriteria: normalizedCriteria.sort((left, right) =>
      JSON.stringify(canonicalize(left)).localeCompare(JSON.stringify(canonicalize(right)))),
  };
  return hash(JSON.stringify(canonicalize(payload)));
}

export function fingerprintStoredMissionContract(
  mission: StoredMissionContract,
  criteria: StoredMissionCriterion[],
): string {
  return fingerprintMissionContract({
    workSessionId: mission.workSessionId,
    workspaceSessionId: mission.workspaceSessionId,
    objective: mission.objective,
    desiredOutcome: mission.desiredOutcome,
    constraints: mission.constraints,
    nonGoals: mission.nonGoals,
    userLockedFields: mission.userLockedFields,
    supervisorInstructions: mission.supervisorInstructions,
    baselineKind: mission.baselineKind,
    baselineRef: mission.baselineRef,
    maxCorrectionRounds: mission.maxCorrectionRounds,
    finalVerification: mission.finalVerification,
    reviewCoverage: mission.reviewCoverage,
  }, criteria.map((criterion) => ({
    description: criterion.description,
    priority: criterion.priority as MissionCriterionInput["priority"],
    verificationType: criterion.verificationType as MissionCriterionInput["verificationType"],
    verificationCommand: criterion.verificationCommand,
    runtimeProbe: criterion.runtimeProbe,
    affectedAreas: criterion.affectedAreas,
    dependsOnCriterionIds: criterion.dependsOnCriterionIds,
    verificationGroup: criterion.verificationGroup,
    verificationScope: criterion.verificationScope as MissionCriterionInput["verificationScope"],
    finalOnly: criterion.finalOnly,
    mutatesWorkspace: criterion.mutatesWorkspace,
    commandVersion: criterion.commandVersion,
  })));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
