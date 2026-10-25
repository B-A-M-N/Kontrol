import { element } from "./ui-dom.js";

type IngressProjection = {
  generatedAt?: string;
  backendState?: string | null;
  dnsName?: string | null;
  notes?: string[];
  endpointPreference?: {
    endpointIds: string[];
    endpoints: Array<{ id: string; state?: string; retryInMs?: number; attempts?: number; successes?: number }>;
  };
  profiles?: Array<{
    id: string; kind: string; audience: string; externalOrigin: string; target: string; enabled: boolean; privacy: string;
    expectedLocalTarget?: string | null; observed?: unknown; classification: string; localObserved?: boolean | null;
    authentication: string; tls: string;
    externalTest?: string;
    qualification?: { state?: string; evidenceTier?: string; observedAt?: string; probeOrigin?: string; checks?: Record<string, boolean>; metrics?: Record<string, number> } | null;
    lastOperation?: { action?: string; state?: string; updatedAt?: string } | null;
    recentFailures?: Array<{ observedAt?: string; state?: string; evidenceTier?: string; failureClass?: string }>;
  }>;
};

export function renderIngressManagementPanel(data: IngressProjection, actions: {
  manage(action: "inspect" | "apply" | "disable" | "set_preference", profileId?: string, preferredEndpointIds?: string[]): Promise<void>;
}, error?: string | null): HTMLElement {
  const main = element("main", { className: "shell ingress-panel" });
  const header = element("header", { className: "ingress-header" });
  header.append(element("h2", { text: "Ingress management" }));
  header.append(element("p", { className: "muted", text: `Tailscale: ${data.backendState ?? "unavailable"}${data.dnsName ? ` · ${data.dnsName}` : ""}` }));
  const refresh = element("button", { className: "ingress-button", text: "Refresh status", type: "button" });
  refresh.addEventListener("click", () => { void actions.manage("inspect"); });
  const exportButton = element("button", { className: "ingress-button secondary", text: "Export diagnostics", type: "button" });
  exportButton.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `kontrol-ingress-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });
  const buttons = element("div", { className: "ingress-actions" });
  buttons.append(refresh, exportButton);
  header.append(buttons);
  if (data.endpointPreference?.endpointIds.length) {
    const preference = element("section", { className: "ingress-profile" });
    preference.append(element("h3", { text: "Client failover preference" }));
    preference.append(element("p", { className: "ingress-evidence", text: "Sets the preferred endpoint for subsequent connection attempts. The active transport is not moved." }));
    const select = element("select", { className: "ingress-select", ariaLabel: "Preferred MCP endpoint" });
    for (const id of data.endpointPreference.endpointIds) {
      const endpoint = data.endpointPreference.endpoints.find((item) => item.id === id);
      const option = document.createElement("option");
      option.value = id;
      option.textContent = `${id} · ${endpoint?.state ?? "eligible"}`;
      select.append(option);
    }
    const savePreference = element("button", { className: "ingress-button", type: "button", text: "Set preferred endpoint" });
    savePreference.addEventListener("click", () => {
      const order = [select.value, ...data.endpointPreference!.endpointIds.filter((id) => id !== select.value)];
      if (window.confirm(`Prefer ${select.value} on the next connection attempt?`)) void actions.manage("set_preference", undefined, order);
    });
    const preferenceControls = element("div", { className: "ingress-actions" });
    preferenceControls.append(select, savePreference);
    preference.append(preferenceControls);
    main.append(preference);
  }
  main.append(header);
  if (error) main.append(element("p", { className: "status error", text: error, role: "alert" }));

  const profiles = data.profiles ?? [];
  if (profiles.length === 0) main.append(element("p", { className: "empty muted", text: "No ingress profiles are configured." }));
  for (const profile of profiles) {
    const card = element("section", { className: "ingress-profile" });
    const top = element("div", { className: "ingress-profile-top" });
    top.append(element("h3", { text: profile.id }));
    top.append(element("span", { className: `ingress-state ${profile.classification.toLowerCase()}`, text: profile.classification.replaceAll("_", " ") }));
    card.append(top);
    const table = element("dl", { className: "ingress-facts" });
    const fields: Array<[string, string]> = [
      ["Exposure", profile.privacy.replaceAll("_", " ")],
      ["Profile", `${profile.kind} · ${profile.audience} · ${profile.enabled ? "enabled" : "standby"}`],
      ["Configured", profile.enabled ? "enabled" : "disabled"],
      ["Listener", `${profile.target}${profile.expectedLocalTarget ? ` · ${profile.expectedLocalTarget}` : ""}`],
      ["Local listener", profile.localObserved === null || profile.localObserved === undefined ? "not observed" : profile.localObserved ? "reachable" : "unreachable"],
      ["Observed mapping", profile.observed ? JSON.stringify(profile.observed) : "none observed"],
      ["External test", profile.externalTest ?? "unverified"],
      ["Certificate / TLS", profile.tls],
      ["Authentication", profile.authentication],
      ["Last qualification", profile.qualification ? `${profile.qualification.state} · ${profile.qualification.evidenceTier} · ${profile.qualification.observedAt}` : "no qualification evidence"],
    ];
    for (const [label, value] of fields) {
      table.append(element("dt", { text: label }), element("dd", { text: value }));
    }
    card.append(table);
    if (profile.qualification?.checks) {
      card.append(element("p", { className: "ingress-evidence", text: `Checks: ${Object.entries(profile.qualification.checks).map(([name, passed]) => `${name} ${passed ? "passed" : "failed"}`).join(" · ")}` }));
    }
    if (profile.lastOperation) card.append(element("p", { className: "ingress-evidence", text: `Last route operation: ${profile.lastOperation.action} · ${profile.lastOperation.state} · ${profile.lastOperation.updatedAt}` }));
    const failures = profile.recentFailures ?? [];
    card.append(element("p", { className: "ingress-evidence", text: failures.length
      ? `Recent failures: ${failures.map((item) => `${item.failureClass ?? item.state} (${item.observedAt ?? "time unknown"})`).join(" · ")}`
      : "Recent failures: none recorded" }));
    const controls = element("div", { className: "ingress-actions" });
    if (profile.kind === "tailscale_serve" || profile.kind === "tailscale_funnel") {
      const apply = element("button", { className: "ingress-button", type: "button", text: "Apply route" });
      apply.disabled = !profile.enabled;
      apply.title = profile.enabled ? "Apply the configured route after confirmation" : "Enable this profile in server configuration first";
      apply.addEventListener("click", () => {
        if (window.confirm(`Apply the Tailscale route for ${profile.id}?`)) void actions.manage("apply", profile.id);
      });
      const disable = element("button", { className: "ingress-button secondary", type: "button", text: "Deactivate route" });
      disable.addEventListener("click", () => {
        if (window.confirm(`Deactivate the Kontrol-owned Tailscale route for ${profile.id}?`)) void actions.manage("disable", profile.id);
      });
      controls.append(apply, disable);
    }
    card.append(controls);
    main.append(card);
  }
  for (const note of data.notes ?? []) main.append(element("p", { className: "ingress-note", text: note }));
  return main;
}
