import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
dom.window.confirm = () => true;

const { renderIngressManagementPanel } = await import("./ingress-management.js");
const actions: Array<[string, string?]> = [];
const panel = renderIngressManagementPanel({
  backendState: "Running",
  profiles: [{
    id: "private-serve", kind: "tailscale_serve", audience: "peer", externalOrigin: "https://node.ts.net", target: "peer_listener",
    enabled: true, privacy: "TAILNET_PRIVATE", expectedLocalTarget: "http://127.0.0.1:7678/", classification: "MAPPING_MATCHED",
    localObserved: true, observed: { hostPort: "node.ts.net:443" }, authentication: "unverified", tls: "unverified", externalTest: "unverified",
    qualification: null, lastOperation: null, recentFailures: [],
  }],
  endpointPreference: {
    endpointIds: ["primary", "secondary"],
    endpoints: [{ id: "primary", state: "eligible" }, { id: "secondary", state: "circuit_open" }],
  },
}, { async manage(action, profileId, endpointIds) { actions.push([action, profileId ?? endpointIds?.join(",")]); } });
document.body.append(panel);
assert.match(panel.textContent ?? "", /configured|enabled/i);
assert.match(panel.textContent ?? "", /unverified/i);
(Array.from(panel.querySelectorAll("button")).find((button) => button.textContent === "Refresh status") as HTMLButtonElement).click();
(Array.from(panel.querySelectorAll("button")).find((button) => button.textContent === "Apply route") as HTMLButtonElement).click();
(panel.querySelector("select") as HTMLSelectElement).value = "secondary";
(Array.from(panel.querySelectorAll("button")).find((button) => button.textContent === "Set preferred endpoint") as HTMLButtonElement).click();
await Promise.resolve();
assert.deepEqual(actions, [["inspect", undefined], ["apply", "private-serve"], ["set_preference", "secondary,primary"]]);
console.log("ingress-management.dom.test.ts: evidence labels and confirmed route controls passed");
