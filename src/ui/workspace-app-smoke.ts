import { App } from "@modelcontextprotocol/ext-apps";

const status = document.querySelector<HTMLElement>("#smoke");
if (!status) throw new Error("Missing smoke status element.");

const app = new App({ name: "kontrol-workspace-app-smoke", version: "1.0.0" }, {});
(app as App & { onerror?: (error: unknown) => void }).onerror = (error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  status.dataset.status = "error";
  status.textContent = `MCP App error: ${message}`;
};

void app.connect().then(() => {
  status.dataset.status = "connected";
  status.textContent = "MCP App connected";
}).catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  status.dataset.status = "error";
  status.textContent = `MCP App connection failed: ${message}`;
});
