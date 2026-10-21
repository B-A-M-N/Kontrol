import { createHash } from "node:crypto";
import type { CdpClient } from "./cdp-client.js";

export interface ReviewerTabBinding {
  profileId: string;
  reviewThreadId: string;
  conversationUrl?: string;
  conversationKey?: string;
  browserGeneration: number;
  targetId?: string;
  cdpSessionId?: string;
  bindingRevision: number;
  status: "unbound" | "provisioning" | "bound" | "detached" | "recovery_required";
}

export interface BoundReviewerTarget {
  targetId: string;
  sessionId: string;
  conversationUrl: string;
  conversationKey: string;
  browserGeneration: number;
}

export class ReviewerTargetError extends Error {
  constructor(readonly code: "wrong_conversation" | "recovery_required" | "target_ambiguous" | "no_target", message: string) {
    super(message);
    this.name = "ReviewerTargetError";
  }
}

export function canonicalReviewerConversation(value: string): { url: string; key: string } {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ReviewerTargetError("wrong_conversation", "Reviewer conversation URL is invalid."); }
  if (parsed.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com"].includes(parsed.hostname.toLowerCase())
    || !/^\/c\/[A-Za-z0-9_-]{8,160}\/?$/.test(parsed.pathname) || parsed.username || parsed.password) {
    throw new ReviewerTargetError("wrong_conversation", "Reviewer binding requires one canonical ChatGPT conversation URL.");
  }
  const key = parsed.pathname.replace(/\/$/, "").slice("/c/".length);
  return { url: `https://chatgpt.com/c/${key}`, key };
}

export function reviewerConversationFingerprint(key: string): string {
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(key)) throw new ReviewerTargetError("wrong_conversation", "Reviewer conversation key is invalid.");
  return createHash("sha256").update(`kontrol-review-conversation-v1\0${key}`).digest("hex");
}

export async function discoverReviewerTargets(cdp: CdpClient): Promise<Array<{ targetId: string; url: string; title: string }>> {
  const result = await cdp.send<{ targetInfos?: Array<Record<string, unknown>> }>("Target.getTargets");
  return (result.targetInfos ?? []).filter((target) => target.type === "page" && typeof target.targetId === "string")
    .map((target) => ({ targetId: String(target.targetId), url: String(target.url ?? ""), title: String(target.title ?? "") }));
}

export async function bindReviewerTarget(input: {
  cdp: CdpClient;
  profileId: string;
  reviewThreadId: string;
  browserGeneration: number;
  targetId: string;
  expectedConversationKey?: string;
  bindingRevision: number;
}): Promise<{ binding: ReviewerTabBinding; target: BoundReviewerTarget }> {
  if (!input.targetId.trim()) throw new ReviewerTargetError("no_target", "An exact reviewer tab target ID is required.");
  const info = (await discoverReviewerTargets(input.cdp)).filter((target) => target.targetId === input.targetId);
  if (info.length !== 1) throw new ReviewerTargetError("no_target", "The explicitly selected reviewer tab is no longer available.");
  const canonical = canonicalReviewerConversation(info[0]!.url);
  if (input.expectedConversationKey && input.expectedConversationKey !== canonical.key) {
    throw new ReviewerTargetError("wrong_conversation", "The selected tab does not match the saved reviewer conversation.");
  }
  const attached = await input.cdp.send<{ sessionId?: string }>("Target.attachToTarget", { targetId: input.targetId, flatten: true });
  if (typeof attached.sessionId !== "string" || !attached.sessionId) throw new ReviewerTargetError("no_target", "Chromium did not attach a CDP session to the selected tab.");
  const rechecked = (await discoverReviewerTargets(input.cdp)).find((target) => target.targetId === input.targetId);
  if (!rechecked || canonicalReviewerConversation(rechecked.url).key !== canonical.key) {
    await input.cdp.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => undefined);
    throw new ReviewerTargetError("wrong_conversation", "The reviewer tab navigated while Kontrol was attaching.");
  }
  const binding: ReviewerTabBinding = {
    profileId: input.profileId,
    reviewThreadId: input.reviewThreadId,
    conversationUrl: canonical.url,
    conversationKey: canonical.key,
    browserGeneration: input.browserGeneration,
    targetId: input.targetId,
    cdpSessionId: attached.sessionId,
    bindingRevision: input.bindingRevision,
    status: "bound",
  };
  return {
    binding,
    target: { targetId: input.targetId, sessionId: attached.sessionId,
      conversationUrl: canonical.url, conversationKey: canonical.key, browserGeneration: input.browserGeneration },
  };
}

export async function restoreReviewerTarget(input: {
  cdp: CdpClient;
  binding: ReviewerTabBinding;
  browserGeneration: number;
}): Promise<BoundReviewerTarget> {
  if (!input.binding.conversationUrl || !input.binding.conversationKey || !input.binding.reviewThreadId) {
    throw new ReviewerTargetError("recovery_required", "The reviewer conversation binding is incomplete.");
  }
  const canonical = canonicalReviewerConversation(input.binding.conversationUrl);
  if (canonical.key !== input.binding.conversationKey) throw new ReviewerTargetError("recovery_required", "Saved reviewer conversation URL and key disagree.");
  let target = input.binding.targetId
    ? (await discoverReviewerTargets(input.cdp)).find((candidate) => candidate.targetId === input.binding.targetId)
    : undefined;
  if (target && canonicalReviewerConversation(target.url).key !== canonical.key) {
    throw new ReviewerTargetError("wrong_conversation", "The previously bound browser tab now displays a different conversation.");
  }
  if (!target) {
    const matches = (await discoverReviewerTargets(input.cdp)).filter((candidate) => {
      try { return canonicalReviewerConversation(candidate.url).key === canonical.key; } catch { return false; }
    });
    if (matches.length > 1) throw new ReviewerTargetError("target_ambiguous", "More than one tab displays the bound reviewer conversation.");
    target = matches[0];
  }
  if (!target) {
    const created = await input.cdp.send<{ targetId?: string }>("Target.createTarget", { url: canonical.url });
    if (typeof created.targetId !== "string") throw new ReviewerTargetError("no_target", "Chromium could not restore the exact reviewer conversation.");
    target = (await discoverReviewerTargets(input.cdp)).find((candidate) => candidate.targetId === created.targetId);
    if (!target || canonicalReviewerConversation(target.url).key !== canonical.key) {
      throw new ReviewerTargetError("wrong_conversation", "Chromium did not restore the exact saved reviewer conversation.");
    }
  }
  const attached = await input.cdp.send<{ sessionId?: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  if (typeof attached.sessionId !== "string") throw new ReviewerTargetError("no_target", "Could not attach to the restored reviewer tab.");
  const verified = (await discoverReviewerTargets(input.cdp)).find((candidate) => candidate.targetId === target!.targetId);
  if (!verified || canonicalReviewerConversation(verified.url).key !== canonical.key) {
    await input.cdp.send("Target.detachFromTarget", { sessionId: attached.sessionId }).catch(() => undefined);
    throw new ReviewerTargetError("wrong_conversation", "Restored tab changed conversation during attachment.");
  }
  return { targetId: verified.targetId, sessionId: attached.sessionId,
    conversationUrl: canonical.url, conversationKey: canonical.key, browserGeneration: input.browserGeneration };
}
