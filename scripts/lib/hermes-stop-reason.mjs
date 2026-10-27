const SUCCESSFUL_STOP_REASONS = new Set(["end_turn"]);
const CANCELLED_STOP_REASONS = new Set(["cancelled", "canceled"]);

/** Translate an ACP stop reason into Kontrol's terminal run outcome. */
export function classifyHermesStopReason(value) {
  const reason = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (SUCCESSFUL_STOP_REASONS.has(reason)) {
    return { status: "completed", message: undefined };
  }
  if (CANCELLED_STOP_REASONS.has(reason)) {
    return { status: "cancelled", message: "Hermes ACP turn was cancelled." };
  }
  if (reason) {
    return {
      status: "failed",
      message: `protocol_incomplete: Hermes ACP turn ended with stop reason ${reason}.`,
    };
  }
  return {
    status: "failed",
    message: "protocol_incomplete: Hermes ACP completion omitted its stop reason.",
  };
}
