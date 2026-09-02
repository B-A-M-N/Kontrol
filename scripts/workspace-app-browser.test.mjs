// Browser-level WUI gate. The jsdom tests cover DOM lifecycles; this test
// loads the same single-file artifact in Chromium so CSS, layout, focus, and
// host-theme behavior are exercised by a real browser engine.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const candidateDir = resolve(process.env.KONTROL_UI_TEST_CANDIDATE_DIR ?? "dist");
const htmlPath = join(candidateDir, "ui", "workspace-app.html");
if (!existsSync(htmlPath)) {
  throw new Error(`Browser WUI gate requires a built artifact at ${htmlPath}`);
}

const now = new Date().toISOString();
const workspaceSessionId = "workspace-browser";
const workSessionId = "session-browser";
const submissionId = "submission-browser-5";

const browser = await chromium.launch({
  headless: true,
  ...(process.env.KONTROL_BROWSER_PATH ? { executablePath: process.env.KONTROL_BROWSER_PATH } : {}),
  ...(process.env.KONTROL_BROWSER_NO_SANDBOX === "1" ? { args: ["--no-sandbox"] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const browserDiagnostics = [];
  page.on("pageerror", (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") browserDiagnostics.push(`console.${message.type()}: ${message.text()}`);
  });
  await page.addInitScript(({ nowValue, workspaceId, sessionId, reviewId }) => {
    // Keep normal boot enabled; only replace the host App transport with the
    // deterministic browser fixture.
    window.__KONTROL_UI_TEST_MODE__ = false;
    window.__KONTROL_UI_TEST_APP_FACTORY__ = () => ({
      ontoolresult: undefined,
      onhostcontextchanged: undefined,
      onteardown: undefined,
      async connect() {
        this.ontoolresult?.({
          _meta: { tool: "open_workspace" },
          structuredContent: { workspaceId: workspaceId },
          content: [],
        });
      },
      getHostContext() {
        return {
          theme: "dark",
          styles: { variables: { "--color-text-primary": "rgb(11, 22, 33)" } },
        };
      },
      async callServerTool(request) {
        switch (request.name) {
          case "get_workspace_session_surface":
            return {
              isError: false,
              content: [],
              structuredContent: {
                lastSeq: 5,
                sessions: [{
                  sessionId,
                  workspaceSessionId: workspaceId,
                  status: "awaiting_review",
                  lifecycle: "awaiting_review",
                  runtimeState: "parked",
                  title: "Browser review",
                  submittedBy: "browser-agent",
                  updatedAt: nowValue,
                  lastHeartbeatAt: nowValue,
                  runId: "run-browser",
                  hasMission: false,
                  lastSeq: 5,
                  submissionCount: 5,
                  unresolvedMessageCount: 0,
                  pendingApprovalCount: 1,
                  latestSubmission: {
                    submissionId: reviewId,
                    submissionNumber: 5,
                    status: "pending",
                    additions: 2,
                    removals: 1,
                    reviewEpoch: 5,
                  },
                }],
              },
            };
          case "get_work_session_snapshot":
            return {
              isError: false,
              content: [],
              structuredContent: {
                sessionId,
                workspaceSessionId: workspaceId,
                status: "awaiting_review",
                title: "Browser review",
                submittedBy: "browser-agent",
                runId: "run-browser",
                lastHeartbeatAt: nowValue,
                submissionCount: 5,
                lastSeq: 5,
                updatedAt: nowValue,
                latestSubmission: {
                  submissionId: reviewId,
                  submissionNumber: 5,
                  status: "pending",
                  additions: 2,
                  removals: 1,
                  reviewEpoch: 5,
                },
                pendingApprovals: [{
                  approvalId: "approval-browser",
                  title: "Allow a tool call",
                  description: "A browser test approval",
                  tool: "bash",
                  origin: "work_session",
                  workSessionId: sessionId,
                  options: [
                    { id: "allow_once", label: "Allow once", effect: "approve", scope: "once" },
                    { id: "deny", label: "Deny", effect: "deny" },
                  ],
                }],
                agentMessages: [],
                hasMission: false,
              },
            };
          case "get_review_submission":
            return {
              isError: false,
              content: [],
              structuredContent: {
                submissionId: reviewId,
                submissionNumber: 5,
                reviewEpoch: 5,
                status: "pending",
                patch: "diff --git a/src/browser.ts b/src/browser.ts\n@@\n-const oldValue = 1;\n+const newValue = 2;\n",
                additions: 2,
                removals: 1,
                files: [{ path: "src/browser.ts", additions: 2, removals: 1 }],
                fileCount: 1,
              },
            };
          case "list_pending_approvals":
            return { isError: false, content: [], structuredContent: { approvals: [] } };
          case "inspect_supervised_work":
            return { isError: false, content: [], structuredContent: { packet: {} } };
          case "await_workspace_events":
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { isError: false, content: [], structuredContent: { events: [], nextSeq: 5 } };
          default:
            return { isError: false, content: [], structuredContent: {} };
        }
      },
    });
  }, { nowValue: now, workspaceId: workspaceSessionId, sessionId: workSessionId, reviewId: submissionId });

  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
  try {
    await page.locator(".workspace-surface").waitFor({ state: "attached", timeout: 5_000 });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${browserDiagnostics.join("\n")}`);
  }
  await page.locator(".review-feedback").waitFor({ state: "attached", timeout: 5_000 });

  assert.equal(await page.locator(".agent-meta-primary").textContent().then((text) => text?.includes("Awaiting review")), true, "primary session state is humanized");
  assert.match(await page.locator(".heartbeat-status").textContent() || "", /^Last heartbeat · \d+s ago$/, "parked review does not claim a live agent");
  assert.equal(await page.locator(".approval-card .feedback-btn").count(), 2, "browser surface uses only server-supplied approval options");
  assert.equal(await page.locator(".feedback-btn").count() > 0, true, "review controls render in Chromium");

  const touchTargets = await page.locator(".feedback-btn").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { height: rect.height, width: rect.width };
  }));
  assert.ok(touchTargets.every((target) => target.height >= 44), "mobile feedback controls meet the 44px touch target");

  await page.waitForFunction(() => {
    const title = document.querySelector(".agent-meta-primary");
    return title !== null && getComputedStyle(title).color === "rgb(11, 22, 33)";
  }, undefined, { timeout: 5_000 });
  const themeState = await page.evaluate(() => {
    const title = document.querySelector(".agent-meta-primary");
    return {
      rootVariable: document.documentElement.style.getPropertyValue("--color-text-primary"),
      computedVariable: getComputedStyle(document.documentElement).getPropertyValue("--color-text-primary"),
      titleStyle: title?.getAttribute("style") ?? "",
      titleTag: title?.tagName ?? "",
      titleConnected: title?.isConnected ?? false,
      titleVariable: title ? getComputedStyle(title).getPropertyValue("--color-text-primary") : "",
      titleColor: title ? getComputedStyle(title).getPropertyValue("color") : "",
      titleFontSize: title ? getComputedStyle(title).getPropertyValue("font-size") : "",
      matchingRules: [...document.styleSheets].flatMap((sheet) => {
        try {
          return [...sheet.cssRules].filter((rule) => rule.selectorText?.includes(".agent-meta-primary")).map((rule) => rule.cssText);
        } catch {
          return [];
        }
      }),
      titleOuter: title?.outerHTML ?? "",
    };
  });
  assert.equal(themeState.titleColor, "rgb(11, 22, 33)", `host theme variables reach the WUI stylesheet: ${JSON.stringify(themeState)}`);

  await page.locator(".feedback-textarea").focus();
  const focusStyle = await page.locator(".feedback-textarea").evaluate((node) => getComputedStyle(node).outlineStyle);
  assert.notEqual(focusStyle, "none", "keyboard focus remains visible");

  console.log("workspace-app browser: Chromium render, responsive controls, focus, theme, and status assertions passed");
} finally {
  await browser.close();
}
