export interface WebhookPolicy {
  enabled: boolean;
  allowedHosts: string[];
}

/**
 * Webhooks are an outbound network capability. Keep them disabled unless the
 * operator opted in and named the exact destination hosts. `*` is accepted
 * only as an explicit opt-in for deployments that intentionally permit any
 * HTTPS/HTTP destination.
 */
export function validateWebhookUrl(value: string, policy: WebhookPolicy): string | undefined {
  if (!policy.enabled) return "webhooks are disabled; set KONTROL_WEBHOOKS=1 to enable them";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "webhook_url must be an absolute URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "webhook_url must use http or https";
  if (parsed.username || parsed.password || parsed.hash) return "webhook_url must not contain credentials or a fragment";
  const allowedHosts = policy.allowedHosts.map((host) => host.toLowerCase());
  if (!allowedHosts.includes("*") && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
    return `webhook host ${parsed.hostname} is not in KONTROL_WEBHOOK_ALLOWED_HOSTS`;
  }
  return undefined;
}
