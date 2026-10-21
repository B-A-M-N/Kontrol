// These reviewer-thread operations are part of the qualified DevSpace MCP surface.
// Keep candidate and external tools/list qualification bound to the same manifest.
export const REQUIRED_REVIEW_THREAD_TOOLS = [
  "prepare_review_thread_activation",
  "activate_review_thread",
  "reattach_review_thread",
  "claim_review_thread_deliveries",
  "acknowledge_review_thread_delivery",
  "claim_review_handoff",
  "renew_review_handoff_claim",
  "submit_handoff_feedback",
];
