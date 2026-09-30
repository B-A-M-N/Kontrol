import { useState } from "react";

export function RawPayloadActions({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "denied">("idle");

  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("denied");
    }
  };

  return (
    <div className="raw-payload-actions">
      <button type="button" className="notice-action" onClick={() => void copy()}>
        Copy Raw
      </button>
      {status === "copied" ? <span className="raw-payload-status" role="status">Copied original text.</span> : null}
      {status === "denied" ? (
        <>
          <span className="raw-payload-status" role="status">Clipboard access denied. Select the original text below to copy it manually.</span>
          <textarea className="raw-payload-fallback" readOnly value={text} aria-label="Original payload text" />
        </>
      ) : null}
    </div>
  );
}
