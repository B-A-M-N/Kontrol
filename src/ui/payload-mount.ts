/**
 * Rich-payload mount lifecycle + surface identity: which renderer is
 * mounted where, with in-place updates and stale-generation unmounts.
 * Extracted verbatim from ui/workspace-app.tsx (P1.4); the mount-state
 * cells became module-local state owned here, reached through an explicit
 * host binding for the app-level cells it coordinates with.
 */
import {
  isReviewTool,
  payloadText,
  summaryNumber,
  type HostContext,
  type ToolResultCard,
} from "./card-types.js";
import { element } from "./ui-dom.js";

export interface PayloadMountHost {
  getLastToolCard(): ToolResultCard | null;
  getHostContext(): HostContext | undefined;
  getErrorMessage(): string | null;
  renderedSurfaceKey(): string | null;
  setRenderedSurfaceKey(v: string | null): void;
  setCurrentWorkSessionDom(v: unknown): void;
}

const unsetPayloadMountHost: PayloadMountHost = {
  getLastToolCard: () => null,
  getHostContext: () => undefined,
  getErrorMessage: () => null,
  renderedSurfaceKey: () => null,
  setRenderedSurfaceKey: () => undefined,
  setCurrentWorkSessionDom: () => undefined,
};

let host: PayloadMountHost = unsetPayloadMountHost;
export function setPayloadMountHost(next: PayloadMountHost): void {
  host = next;
}

/** True while a payload renderer is mounted at all. */
export function hasMountedPayload(): boolean {
  return currentPayload !== null;
}

/** Point the payload renderer at a new container (mount target). */
export function setPayloadContainer(target: HTMLElement | null): void {
  currentPayloadContainer = target;
}

/** Container the payload renderer is mounted into (for layout parents). */
export function currentPayloadContainerElement(): HTMLElement | null {
  return currentPayloadContainer;
}

let currentPayload: {
  update(options: { card: ToolResultCard; hostContext?: HostContext; errorMessage?: string | null; visibleFileCount?: number }): void;
  unmount(): void;
} | null = null;
let currentPayloadContainer: HTMLElement | null = null;
let currentPayloadCard: ToolResultCard | null = null;
let currentPayloadKind: "heavy" | "review" | null = null;
let currentPayloadKey: string | null = null;
let payloadLoadingKey: string | null = null;
let generation = 0;

export function ensureSurface(key: string): void {
  if (host.renderedSurfaceKey() === key) return;
  unmountPayload();
  host.setCurrentWorkSessionDom(null);
  host.setRenderedSurfaceKey(key);
}

export function renderSummaryBadge(card: ToolResultCard): HTMLElement {
  const badge = element("span", { className: "tool-badge", ariaHidden: "true" });
  if (isReviewTool(card.tool)) {
    const files = summaryNumber(card.summary, "files") ?? card.files?.length ?? 0;
    badge.textContent = files > 0 ? `${files} file${files === 1 ? "" : "s"}` : "review";
  } else if (card.summary?.status) {
    badge.textContent = String(card.summary.status);
  } else if (card.path) {
    badge.textContent = card.path.split("/").pop() ?? card.path;
  } else {
    badge.textContent = card.tool;
  }
  return badge;
}

export function unmountPayload(): void {
  generation += 1;
  if (currentPayload) {
    try {
      currentPayload.unmount();
    } catch {
      /* ignore */
    }
    currentPayload = null;
  }
  if (currentPayloadContainer) {
    currentPayloadContainer.replaceChildren();
  }
  currentPayloadContainer = null;
  currentPayloadCard = null;
  currentPayloadKind = null;
  currentPayloadKey = null;
  payloadLoadingKey = null;
}

export function renderPayloadIfNeeded(
  payloadCard?: ToolResultCard | null,
  visibleFileCount?: number,
): void {
  const target = currentPayloadContainer;
  if (!target) return;
  const card = payloadCard === undefined ? currentPayloadCard ?? host.getLastToolCard() : payloadCard;
  if (!card) return;
  currentPayloadCard = card;

  const kind = isReviewTool(card.tool) ? "review" : "heavy";
  // The renderer identity is the selected card/submission, not its mutable
  // payload. Content and theme updates must flow through update(); remounting
  // Pierre on every output fragment loses scroll position and focus.
  const identity = isReviewTool(card.tool)
    ? String(card.summary?.submissionId ?? card.workSessionId ?? card.path ?? card.tool)
    : String(card.path ?? card.workSessionId ?? card.tool);
  const key = `${kind}:${card.tool}:${identity}`;
  if (currentPayloadContainer === target && currentPayload && currentPayloadKind === kind && currentPayloadKey === key) {
    currentPayload.update({ card, hostContext: host.getHostContext(), errorMessage: host.getErrorMessage(), visibleFileCount });
    return;
  }

  if (currentPayloadContainer === target && !currentPayload && payloadLoadingKey === key) return;

  if (currentPayloadContainer !== target || currentPayloadKind !== kind || currentPayloadKey !== key) {
    if (currentPayload) {
      try { currentPayload.unmount(); } catch { /* ignore renderer teardown failures */ }
      currentPayload = null;
    }
    currentPayloadContainer = target;
    currentPayloadKind = kind;
    currentPayloadKey = key;
    payloadLoadingKey = key;
    target.replaceChildren(element("div", { className: "status muted", text: "Loading rich payload…" }));
    const mountGeneration = ++generation;
    const options = { card, hostContext: host.getHostContext(), errorMessage: host.getErrorMessage(), visibleFileCount };
    void (kind === "review"
      ? import("./review-payload.js").then(({ mountReviewPayload }) => mountReviewPayload(target, options))
      : import("./heavy-payload.js").then(({ mountHeavyPayload }) => mountHeavyPayload(target, options)))
      .then((mounted) => {
        if (mountGeneration !== generation || currentPayloadContainer !== target || currentPayloadKey !== key) {
          try { mounted.unmount(); } catch { /* ignore stale renderer teardown failures */ }
          return;
        }
        currentPayload = mounted;
        payloadLoadingKey = null;
        // Host theme or card payload may have changed while the lazy module was
        // loading. Apply the newest values without another mount.
        mounted.update({ card: currentPayloadCard ?? card, hostContext: host.getHostContext(), errorMessage: host.getErrorMessage(), visibleFileCount });
      })
      .catch((error) => {
        if (mountGeneration !== generation || currentPayloadContainer !== target || currentPayloadKey !== key) return;
        currentPayload = null;
        payloadLoadingKey = null;
        target.replaceChildren(element("pre", {
          className: "text-payload fallback",
          text: payloadText(card.payload) || card.payload?.patch || `Rich renderer failed: ${error instanceof Error ? error.message : String(error)}`,
        }));
      });
  }
}

