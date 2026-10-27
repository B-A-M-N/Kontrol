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

export interface CatalogRefreshSendOptions {
  /**
   * Reports whether the delivery surface that carries this send is still the
   * one the send started on. A send that completes after its surface ended may
   * never have reached the host, so its success is discarded instead of
   * marking the channel sent.
   */
  isDeliveryStillValid?: () => boolean;
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
  options: CatalogRefreshSendOptions = {},
): Promise<"sent" | "failed" | "already_sent" | "in_flight" | "backoff" | "exhausted" | "stale"> {
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
    if (options.isDeliveryStillValid && !options.isDeliveryStillValid()) {
      // The delivery surface ended while this send was in flight. The send may
      // never have reached the host, so it is not a success: the channel stays
      // eligible and the next delivery surface carries it. The attempt was made
      // against a surface that is gone, so it does not consume the bounded
      // retry budget of the next surface either.
      state[attemptsKey] = Math.max(0, state[attemptsKey] - 1);
      // The backoff timestamp is restored for the same reason, so the next
      // delivery surface is not delayed by a backoff that a discarded send
      // never earned. The restore is NARROWED to the timestamp this send
      // advanced: when the surface ending also re-armed the channel, that
      // re-arm owns the state and the restore must not resurrect a timestamp
      // on a fresh surface.
      if (state[lastAttemptKey] === now) state[lastAttemptKey] = previousAttemptAt;
      return "stale";
    }
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
