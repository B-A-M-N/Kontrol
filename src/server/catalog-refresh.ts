export type CatalogRefreshChannel = "tools" | "resources";

export interface CatalogRefreshChannelState {
  toolListRefreshSent: boolean;
  resourceListRefreshSent: boolean;
  toolListRefreshAttempts: number;
  resourceListRefreshAttempts: number;
  toolListRefreshSuccesses: number;
  resourceListRefreshSuccesses: number;
  toolListRefreshFailures: number;
  resourceListRefreshFailures: number;
  toolListRefreshLastAttemptMs?: number;
  resourceListRefreshLastAttemptMs?: number;
  toolListRefreshInFlight: boolean;
  resourceListRefreshInFlight: boolean;
}

const MAX_ATTEMPTS = 3;
const INITIAL_RETRY_BACKOFF_MS = 100;
const MAX_RETRY_BACKOFF_MS = 1_000;
const SEND_DEADLINE_MS = 1_500;

/** Send at most three times, retrying only failed channels on later opportunities. */
export async function sendCatalogRefreshNotification(
  state: CatalogRefreshChannelState,
  channel: CatalogRefreshChannel,
  send: () => Promise<void>,
  onFailure: (error: unknown) => void,
  now = Date.now(),
): Promise<"sent" | "failed" | "already_sent" | "in_flight" | "backoff" | "exhausted"> {
  const prefix = channel === "tools" ? "toolList" : "resourceList";
  const sentKey = `${prefix}RefreshSent` as const;
  const attemptsKey = `${prefix}RefreshAttempts` as const;
  const successesKey = `${prefix}RefreshSuccesses` as const;
  const failuresKey = `${prefix}RefreshFailures` as const;
  const lastAttemptKey = `${prefix}RefreshLastAttemptMs` as const;
  const inFlightKey = `${prefix}RefreshInFlight` as const;

  if (state[sentKey]) return "already_sent";
  if (state[inFlightKey]) return "in_flight";
  const attempts = state[attemptsKey];
  if (attempts >= MAX_ATTEMPTS) return "exhausted";
  const previousAttemptAt = state[lastAttemptKey];
  const retryDelay = Math.min(MAX_RETRY_BACKOFF_MS, INITIAL_RETRY_BACKOFF_MS * (2 ** Math.max(0, attempts - 1)));
  if (previousAttemptAt !== undefined && now - previousAttemptAt < retryDelay) return "backoff";

  state[inFlightKey] = true;
  state[attemptsKey] += 1;
  state[lastAttemptKey] = now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      send(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("list-changed notification send deadline exceeded")), SEND_DEADLINE_MS);
        timer.unref?.();
      }),
    ]);
    state[successesKey] += 1;
    state[sentKey] = true;
    return "sent";
  } catch (error) {
    state[failuresKey] += 1;
    onFailure(error);
    return "failed";
  } finally {
    if (timer) clearTimeout(timer);
    state[inFlightKey] = false;
  }
}
