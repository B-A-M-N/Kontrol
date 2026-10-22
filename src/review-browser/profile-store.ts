import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client.js";
import { reviewBrowserProfiles } from "../db/schema.js";

export type ReviewerBrowserMode = "headed" | "headless";
export type ReviewerBrowserProfileStatus = "stopped" | "starting" | "login_required" | "ready" | "busy" | "recovering" | "blocked";
export type ReviewerBrowserAuthState = "unknown" | "manual_auth_required" | "manual_auth_in_progress" | "handoff_pending" | "authenticated" | "auth_blocked";

export interface ReviewerBrowserProfile {
  id: string;
  ownerPrincipalId: string;
  browserEngine: "chromium";
  mode: ReviewerBrowserMode;
  status: ReviewerBrowserProfileStatus;
  authState: ReviewerBrowserAuthState;
  generation: number;
  lastVerifiedAt?: string;
}

const PROFILE_ID = /^[a-z][a-z0-9-]{0,47}$/;

async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Reviewer browser profile paths must be real directories, not symlinks.");
  if (await realpath(absolute) !== absolute) throw new Error("Reviewer browser profile path resolves through a symlink.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Reviewer browser profile directory belongs to another local user.");
  await chmod(absolute, 0o700);
}

function fromRow(row: typeof reviewBrowserProfiles.$inferSelect): ReviewerBrowserProfile {
  return {
    id: row.id,
    ownerPrincipalId: row.ownerPrincipalId,
    browserEngine: "chromium",
    mode: row.mode as ReviewerBrowserMode,
    status: row.status as ReviewerBrowserProfileStatus,
    authState: row.authState as ReviewerBrowserAuthState,
    generation: row.generation,
    lastVerifiedAt: row.lastVerifiedAt ?? undefined,
  };
}

export interface ReviewerBrowserProfileStore {
  create(input: { id: string; ownerPrincipalId: string; mode?: ReviewerBrowserMode }): ReviewerBrowserProfile;
  get(profileId: string): ReviewerBrowserProfile | undefined;
  listForOwner(ownerPrincipalId: string): ReviewerBrowserProfile[];
  profileDirectory(profileId: string): Promise<string>;
  transition(input: { profileId: string; expectedGeneration: number; status: ReviewerBrowserProfileStatus; mode?: ReviewerBrowserMode; authState?: ReviewerBrowserAuthState; verified?: boolean }): ReviewerBrowserProfile;
}

export function createReviewerBrowserProfileStore(database: DatabaseHandle, stateDir: string): ReviewerBrowserProfileStore {
  const profileRoot = join(resolve(stateDir), "reviewer-browser", "profiles");
  const assertId = (value: string) => {
    if (!PROFILE_ID.test(value)) throw new Error("Reviewer browser profile IDs must be lowercase names using letters, digits, and hyphens.");
  };
  return {
    create(input) {
      assertId(input.id);
      if (!input.ownerPrincipalId.trim()) throw new Error("A reviewer browser profile requires an authenticated owner principal.");
      const now = new Date().toISOString();
      const existing = database.db.select().from(reviewBrowserProfiles).where(eq(reviewBrowserProfiles.id, input.id)).get();
      if (existing) {
        if (existing.ownerPrincipalId !== input.ownerPrincipalId) throw new Error("Reviewer browser profile belongs to another principal.");
        return fromRow(existing);
      }
      database.db.insert(reviewBrowserProfiles).values({
        id: input.id,
        ownerPrincipalId: input.ownerPrincipalId,
        browserEngine: "chromium",
        mode: input.mode ?? "headed",
        status: "stopped",
        authState: "unknown",
        generation: 0,
        createdAt: now,
        updatedAt: now,
      }).run();
      return fromRow(database.db.select().from(reviewBrowserProfiles).where(eq(reviewBrowserProfiles.id, input.id)).get()!);
    },
    get(profileId) {
      assertId(profileId);
      const row = database.db.select().from(reviewBrowserProfiles).where(eq(reviewBrowserProfiles.id, profileId)).get();
      return row ? fromRow(row) : undefined;
    },
    listForOwner(ownerPrincipalId) {
      return database.db.select().from(reviewBrowserProfiles).where(eq(reviewBrowserProfiles.ownerPrincipalId, ownerPrincipalId)).all().map(fromRow);
    },
    async profileDirectory(profileId) {
      assertId(profileId);
      const profile = this.get(profileId);
      if (!profile) throw new Error("Reviewer browser profile is not registered.");
      await ensurePrivateDirectory(profileRoot);
      const directory = join(profileRoot, profileId);
      await ensurePrivateDirectory(directory);
      if (dirname(resolve(directory)) !== resolve(profileRoot)) throw new Error("Reviewer browser profile path escaped its private profile root.");
      return directory;
    },
    transition(input) {
      const current = database.db.select().from(reviewBrowserProfiles).where(eq(reviewBrowserProfiles.id, input.profileId)).get();
      if (!current || current.generation !== input.expectedGeneration) throw new Error("Reviewer browser profile generation changed concurrently.");
      const generation = input.status === "starting" ? current.generation + 1 : current.generation;
      const now = new Date().toISOString();
      const updated = database.db.update(reviewBrowserProfiles).set({
        status: input.status,
        authState: input.authState ?? current.authState,
        mode: input.mode ?? current.mode,
        generation,
        lastVerifiedAt: input.verified ? now : current.lastVerifiedAt,
        updatedAt: now,
      }).where(and(eq(reviewBrowserProfiles.id, current.id), eq(reviewBrowserProfiles.generation, current.generation))).run();
      if (updated.changes !== 1) throw new Error("Reviewer browser profile transition lost its compare-and-swap.");
      return fromRow(database.db.select().from(reviewBrowserProfiles).where(eq(reviewBrowserProfiles.id, current.id)).get()!);
    },
  };
}
