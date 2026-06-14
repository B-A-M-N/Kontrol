import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PatchDiff } from "@pierre/diffs/react";
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./workspace-app.css";

interface EditSummary {
  additions: number;
  removals: number;
  editCount: number;
}

interface EditResultCard {
  tool: "edit_file";
  resultId: string;
  workspaceId: string;
  status: "applied";
  path: string;
  summary: EditSummary;
  ui: {
    card: "file-diff";
    expandable: boolean;
  };
}

interface EditPayload {
  diff?: string;
  patch?: string;
}

interface PayloadResult {
  payload?: EditPayload;
}

type LoadState = "idle" | "loading" | "loaded" | "error";
type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

function isEditResultCard(value: unknown): value is EditResultCard {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<EditResultCard>;
  return candidate.tool === "edit_file" && candidate.ui?.card === "file-diff";
}

function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function AppRoot() {
  const appRef = useRef<App | null>(null);
  const [app, setApp] = useState<App | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hostContext, setHostContext] = useState<HostContext | undefined>();
  const [card, setCard] = useState<EditResultCard | null>(null);
  const [payload, setPayload] = useState<EditPayload | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (appRef.current) return;

    const createdApp = new App(
      { name: "pi-on-mcp-edit-diff", version: "0.2.0" },
      {},
    );
    appRef.current = createdApp;

    createdApp.ontoolresult = (result) => {
      const structured = result.structuredContent;
      if (!isEditResultCard(structured)) {
        setCard(null);
        setPayload(null);
        setExpanded(false);
        setLoadState("idle");
        setErrorMessage("No diff card is available for this tool result.");
        return;
      }

      setCard(structured);
      setPayload(null);
      setExpanded(false);
      setLoadState("idle");
      setErrorMessage(null);
    };

    createdApp.onhostcontextchanged = (ctx) => {
      setHostContext((current: HostContext | undefined) => ({
        ...current,
        ...ctx,
      }));
    };

    createdApp.onteardown = async () => ({});

    void createdApp
      .connect()
      .then(() => {
        const initialContext = createdApp.getHostContext();
        if (initialContext) setHostContext(initialContext);
        setApp(createdApp);
        setConnected(true);
      })
      .catch((connectError: unknown) => {
        setConnectionError(
          connectError instanceof Error
            ? connectError.message
            : String(connectError),
        );
      });
  }, []);

  useEffect(() => {
    if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
    if (hostContext?.styles?.variables) {
      applyHostStyleVariables(hostContext.styles.variables);
    }
    if (hostContext?.styles?.css?.fonts) {
      applyHostFonts(hostContext.styles.css.fonts);
    }

    const insets = hostContext?.safeAreaInsets;
    if (!insets) return;

    document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  }, [hostContext?.safeAreaInsets]);

  const themeType: "light" | "dark" =
    hostContext?.theme === "light" ? "light" : "dark";

  const diffOptions = useMemo(
    () => ({
      theme: {
        light: "pierre-light",
        dark: "pierre-dark",
      },
      themeType,
      diffStyle: "unified" as const,
      diffIndicators: "bars" as const,
      hunkSeparators: "line-info" as const,
      lineDiffType: "word-alt" as const,
      overflow: "scroll" as const,
      collapsedContextThreshold: 4,
      expansionLineCount: 20,
      stickyHeader: true,
    }),
    [themeType],
  );

  const loadPayload = useCallback(async () => {
    if (!app || !card || payload || loadState === "loading") return;

    setLoadState("loading");
    setErrorMessage(null);

    try {
      const result = await app.callServerTool({
        name: "get_edit_result_payload",
        arguments: {
          workspaceId: card.workspaceId,
          resultId: card.resultId,
        },
      });
      const structured = getStructuredContent<PayloadResult>(result);
      setPayload(structured?.payload ?? {});
      setLoadState("loaded");
    } catch (payloadError) {
      setErrorMessage(
        payloadError instanceof Error
          ? payloadError.message
          : String(payloadError),
      );
      setLoadState("error");
    }
  }, [app, card, loadState, payload]);

  const toggleExpanded = useCallback(() => {
    setExpanded((nextExpanded) => {
      const shouldExpand = !nextExpanded;
      if (shouldExpand) void loadPayload();
      return shouldExpand;
    });
  }, [loadPayload]);

  if (connectionError) return <EmptyState message={connectionError} tone="error" />;
  if (!connected) return <EmptyState message="Connecting to host..." />;
  if (!card) {
    return (
      <EmptyState
        message={errorMessage ?? "Waiting for an edit result."}
        tone={errorMessage ? "error" : "muted"}
      />
    );
  }

  const patch = payload?.patch || payload?.diff;

  return (
    <main className="shell">
      <section className="diff-card">
        <button
          className="diff-header"
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <span className="file-icon" aria-hidden="true">
            +
          </span>
          <span className="path" title={card.path}>
            {card.path}
          </span>
          <span className="stats" aria-label="Diff statistics">
            <span className="add">+{card.summary.additions}</span>
            <span className="remove">-{card.summary.removals}</span>
          </span>
          <span className="chevron" aria-hidden="true">
            {expanded ? "^" : "v"}
          </span>
        </button>

        {expanded ? (
          <div className="diff-body">
            {loadState === "loading" ? (
              <StatusLine message="Loading diff..." />
            ) : loadState === "error" ? (
              <StatusLine message={errorMessage ?? "Unable to load diff."} tone="error" />
            ) : patch ? (
              <PatchDiff
                patch={patch}
                options={diffOptions}
                className="pierre-diff"
                disableWorkerPool
              />
            ) : (
              <StatusLine message="Diff payload is not available." />
            )}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function EmptyState({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return (
    <main className="shell">
      <section className={`empty ${tone}`}>{message}</section>
    </main>
  );
}

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}

createRoot(document.querySelector("#app")!).render(<AppRoot />);
