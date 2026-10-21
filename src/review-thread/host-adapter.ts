import type { App } from "@modelcontextprotocol/ext-apps";

export interface ReviewHostAdapter {
  capabilities(): {
    createThread: boolean;
    sendMessage: boolean;
    observeAcknowledgement: boolean;
  };
  sendMessage(message: string): Promise<{ status: "accepted" | "rejected" }>;
}

/**
 * MCP Apps can message the currently active host conversation. They cannot
 * create a ChatGPT thread, and an accepted request does not prove that the
 * model read or acted on the message.
 */
export function createMcpAppsReviewHostAdapter(app: App): ReviewHostAdapter {
  const hostCapabilities = () => typeof app.getHostCapabilities === "function"
    ? app.getHostCapabilities()
    : undefined;
  return {
    capabilities: () => ({
      createThread: false,
      sendMessage: Boolean(hostCapabilities()?.message?.text),
      // App.sendMessage reports whether the host accepted the request. It does
      // not expose whether the reviewer model consumed the prompt or replied.
      observeAcknowledgement: false,
    }),
    async sendMessage(message) {
      const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: message }] });
      return { status: result.isError ? "rejected" : "accepted" };
    },
  };
}
