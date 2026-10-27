import type { CdpClient } from "./cdp-client.js";
import { CdpCommandError } from "./cdp-client.js";
import type { BoundReviewerTarget } from "./target-binding.js";
import { canonicalReviewerConversation } from "./target-binding.js";

export type BrowserReadiness =
  | { status: "ready"; conversationUrl: string; conversationKey: string }
  | { status: "generation_active"; conversationUrl: string; conversationKey: string }
  | { status: "login_required" | "verification_required" | "identity_provider_rejected" | "identity_provider_unsupported_browser" | "session_expired" | "authentication_handoff_failed" | "connector_authorization_required" | "composer_unavailable" | "wrong_conversation" | "navigation_unconfirmed" | "browser_transport_failed" | "browser_disconnected"; detail?: string };
export type AuthenticationFailure = "login_required" | "identity_provider_unsupported_browser" | "verification_required" | "session_expired" | "authentication_handoff_failed";
export interface TurnBaseline { conversationKey: string; userMessageCount: number; assistantMessageCount: number; capturedAt: string }
export type PromptSubmission = { status: "accepted"; submittedAt: string; conversationKey: string }
  | { status: "rejected"; reason: string }
  | { status: "uncertain"; reason: string };
export type GenerationState = "not_started" | "generating" | "finished" | "blocked" | "unknown";

export class BrowserReadinessError extends Error {
  constructor(readonly readiness: BrowserReadiness["status"]) {
    super(`Reviewer browser is not ready: ${readiness}.`);
    this.name = "BrowserReadinessError";
  }
}

const ORIGIN = "https://chatgpt.com";
const COMPOSERS = ["#prompt-textarea", "[data-testid='prompt-textarea']", "[contenteditable='true'][role='textbox']"];
const SENDS = ["button[data-testid='send-button']", "button[aria-label='Send prompt']", "button[aria-label^='Send' i]"];
const STOPS = ["button[data-testid='stop-button']", "button[aria-label*='Stop generating' i]"];
const inspectPage = `(() => {
  const url = location.href, parsed = new URL(url), path = parsed.pathname;
  if (parsed.hostname.toLowerCase() === 'accounts.google.com') return {status:'identity_provider_rejected'};
  if (!/(^|\\.)chatgpt\\.com$/i.test(parsed.hostname)) return {status:'wrong_conversation'};
  const body = (document.body?.innerText || '').toLowerCase();
  const visible = e => { const r=e.getBoundingClientRect(), s=getComputedStyle(e); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; };
  const select = selectors => { const set=new Set(); for (const s of selectors) for (const e of document.querySelectorAll(s)) if (visible(e)) set.add(e); return [...set]; };
  if (/^\\/auth\\/(login|signin)|^\\/login/.test(path)) return {status:'login_required'};
  if (['insecure browser','unsupported browser','browser may not be secure'].some(x=>body.includes(x))) return {status:'identity_provider_unsupported_browser'};
  if (['session expired','your session has expired'].some(x=>body.includes(x))) return {status:'session_expired'};
  if (['verify you are human','security check','complete the captcha','unusual activity'].some(x=>body.includes(x)) || document.querySelector('iframe[src*="captcha"],iframe[title*="challenge" i]')) return {status:'verification_required'};
  if (!url.startsWith('${ORIGIN}/')) return {status:'wrong_conversation'};
  const match=path.match(/^\\/c\\/([A-Za-z0-9_-]{8,160})\\/?$/);
  if (!match) return {status:'login_required'};
  const conversation={url:'https://chatgpt.com/c/'+match[1],key:match[1]};
  if (select(${JSON.stringify(STOPS)}).length) return {status:'generation_active',...conversation};
  const composers=select(${JSON.stringify(COMPOSERS)});
  if (composers.length!==1 || composers[0].matches(':disabled') || composers[0].getAttribute('aria-disabled')==='true') return {status:'composer_unavailable'};
  return {status:'ready',...conversation};
})()`;

export class ChatGptPageDriver {
  constructor(private readonly cdp: CdpClient, private readonly target: BoundReviewerTarget) {}

  async inspect(expectedKey = this.target.conversationKey): Promise<BrowserReadiness> {
    try {
      const value = await this.evaluate<{ status: string; url?: string; key?: string }>(inspectPage);
      if (value.status === "generation_active") {
        const canonical = canonicalReviewerConversation(value.url ?? "");
        if (canonical.key !== value.key || canonical.key !== expectedKey || canonical.key !== this.target.conversationKey) return { status: "wrong_conversation" };
        return { status: "generation_active", conversationUrl: canonical.url, conversationKey: canonical.key };
      }
      if (value.status !== "ready") return { status: value.status as Exclude<BrowserReadiness, { status: "ready" } | { status: "generation_active" }>["status"] };
      const canonical = canonicalReviewerConversation(value.url ?? "");
      if (canonical.key !== expectedKey || canonical.key !== this.target.conversationKey) return { status: "wrong_conversation" };
      return { status: "ready", conversationUrl: canonical.url, conversationKey: canonical.key };
    } catch { return { status: "browser_transport_failed" }; }
  }

  async captureBaseline(): Promise<TurnBaseline> {
    const ready = await this.inspect();
    if (ready.status !== "ready") throw new BrowserReadinessError(ready.status);
    const counts = await this.evaluate<{ userMessageCount: number; assistantMessageCount: number }>(`(() => ({userMessageCount:document.querySelectorAll('[data-message-author-role="user"]').length,assistantMessageCount:document.querySelectorAll('[data-message-author-role="assistant"]').length}))()`);
    return { conversationKey: ready.conversationKey, ...counts, capturedAt: new Date().toISOString() };
  }

  async submitPrompt(input: { prompt: string; attemptId: string; expectedConversationKey: string; baseline: TurnBaseline }): Promise<PromptSubmission> {
    if (!input.prompt.trim() || Buffer.byteLength(input.prompt, "utf8") > 48_000) return { status: "rejected", reason: "prompt_size_invalid" };
    const ready = await this.inspect(input.expectedConversationKey);
    if (ready.status !== "ready" && ready.status !== "generation_active") return { status: "rejected", reason: ready.status };
    if (input.baseline.conversationKey !== ready.conversationKey) return { status: "rejected", reason: "baseline_conversation_mismatch" };
    const prior = await this.evaluate<{ found: boolean; exact: boolean }>(`(() => {
      const users=[...document.querySelectorAll('[data-message-author-role="user"]')];
      const matches=users.filter(e=>(e.innerText||'').includes(${JSON.stringify(input.attemptId)}));
      if(!matches.length)return{found:false,exact:false};
      return{found:true,exact:(matches[matches.length-1].innerText||'').trim()===${JSON.stringify(input.prompt)}};
    })()`);
    if (prior.found) return prior.exact
      ? { status: "accepted", submittedAt: new Date().toISOString(), conversationKey: ready.conversationKey }
      : { status: "uncertain", reason: "attempt_id_already_present_with_unmatched_prompt" };
    if (ready.status !== "ready") return { status: "rejected", reason: ready.status };
    const preparation = await this.evaluate<{ ok: boolean; reason?: string }>(`(() => {
      const selectors=${JSON.stringify(COMPOSERS)}, found=new Set();
      for(const s of selectors)for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect(),c=getComputedStyle(e);if(r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden')found.add(e)}
      if(found.size!==1)return{ok:false,reason:'composer_not_unique'};
      const e=[...found][0], text=('value'in e?e.value:e.innerText||'').trim();
      if(e.matches(':disabled')||e.getAttribute('aria-disabled')==='true')return{ok:false,reason:'composer_disabled'};
      if(text)return{ok:false,reason:'composer_not_empty'};e.focus();return{ok:true};
    }))()`);
    if (!preparation.ok) return { status: "rejected", reason: preparation.reason ?? "composer_unavailable" };
    try { await this.cdp.send("Input.insertText", { text: input.prompt }, this.target.sessionId); }
    catch (error) { return { status: error instanceof CdpCommandError && error.effectUncertain ? "uncertain" : "rejected", reason: "text_insertion_failed" }; }
    const verified = await this.evaluate<boolean>(`(() => {
      const selectors=${JSON.stringify(COMPOSERS)},found=new Set();for(const s of selectors)for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect(),c=getComputedStyle(e);if(r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden')found.add(e)}
      if(found.size!==1)return false;const e=[...found][0];return ('value'in e?e.value:e.innerText||'')===${JSON.stringify(input.prompt)};
    })()`);
    if (!verified) return { status: "rejected", reason: "prompt_text_verification_failed" };
    const send = await this.evaluate<{ ok: boolean; x?: number; y?: number }>(`(() => {
      const selectors=${JSON.stringify(SENDS)},found=new Set();for(const s of selectors)for(const e of document.querySelectorAll(s)){const r=e.getBoundingClientRect(),c=getComputedStyle(e);if(r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden')found.add(e)}
      if(found.size!==1)return{ok:false};const e=[...found][0];if(e.matches(':disabled')||e.getAttribute('aria-disabled')==='true')return{ok:false};const r=e.getBoundingClientRect();return{ok:true,x:r.left+r.width/2,y:r.top+r.height/2};
    })()`);
    if (!send.ok || !Number.isFinite(send.x) || !Number.isFinite(send.y)) return { status: "rejected", reason: "send_control_ambiguous" };
    try {
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: send.x, y: send.y }, this.target.sessionId);
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: send.x, y: send.y, button: "left", clickCount: 1 }, this.target.sessionId);
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: send.x, y: send.y, button: "left", clickCount: 1 }, this.target.sessionId);
    } catch (error) { return { status: "uncertain", reason: error instanceof CdpCommandError ? "send_effect_uncertain" : "send_action_failed" }; }
    try {
      const accepted = await this.evaluate<boolean>(`new Promise(resolve=>{
        const matches=()=>{const items=[...document.querySelectorAll('[data-message-author-role="user"]')],last=items[items.length-1];return items.length>${input.baseline.userMessageCount}&&(last?.innerText||'').trim()===${JSON.stringify(input.prompt)}};
        if(matches())return resolve(true);const observer=new MutationObserver(()=>{if(matches()){observer.disconnect();resolve(true)}});observer.observe(document.body,{childList:true,subtree:true,characterData:true});setTimeout(()=>{observer.disconnect();resolve(matches())},8000);
      })`, 10_000, true);
      const after = await this.inspect(input.expectedConversationKey);
      if (after.status !== "ready" && after.status !== "generation_active") return { status: "uncertain", reason: after.status };
      return accepted ? { status: "accepted", submittedAt: new Date().toISOString(), conversationKey: after.conversationKey }
        : { status: "uncertain", reason: "prompt_acceptance_not_observed" };
    } catch { return { status: "uncertain", reason: "post_send_observation_unavailable" }; }
  }

  async observeGeneration(baseline: TurnBaseline, attemptId?: string): Promise<GenerationState> {
    const ready = await this.inspect(baseline.conversationKey);
    if (["login_required", "verification_required", "identity_provider_rejected", "identity_provider_unsupported_browser", "session_expired", "authentication_handoff_failed", "wrong_conversation"].includes(ready.status)) return "blocked";
    if (ready.status === "browser_transport_failed" || ready.status === "browser_disconnected") return "unknown";
    if (ready.status === "generation_active") return "generating";
    if (ready.status !== "ready") return "not_started";
    const state = await this.evaluate<{ assistants: number; generating: boolean; attemptPresent: boolean }>(`(() => {
      const users=[...document.querySelectorAll('[data-message-author-role="user"]')],last=users[users.length-1];
      return {assistants:document.querySelectorAll('[data-message-author-role="assistant"]').length,
        generating:${JSON.stringify(STOPS)}.some(s=>[...document.querySelectorAll(s)].some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'})),
        attemptPresent:${attemptId ? `(last?.innerText||'').includes(${JSON.stringify(attemptId)})` : "true"}};
    })()`);
    if (!state.attemptPresent) return "unknown";
    if (state.generating) return "generating";
    return state.assistants > baseline.assistantMessageCount ? "finished" : "not_started";
  }

  async waitForGeneration(baseline: TurnBaseline, attemptId: string, phase: "start" | "finish", timeoutMs = 30 * 60_000): Promise<GenerationState> {
    const ready = await this.inspect(baseline.conversationKey);
    if (["login_required", "verification_required", "identity_provider_rejected", "identity_provider_unsupported_browser", "session_expired", "authentication_handoff_failed", "wrong_conversation"].includes(ready.status)) return "blocked";
    if (ready.status === "browser_transport_failed" || ready.status === "browser_disconnected") return "unknown";
    const expression = `new Promise(resolve => {
      const baseline=${JSON.stringify(baseline)}, attempt=${JSON.stringify(attemptId)}, phase=${JSON.stringify(phase)};
      const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
      const inspect=()=>{const users=[...document.querySelectorAll('[data-message-author-role="user"]')],last=users[users.length-1];
        if(!(last?.innerText||'').includes(attempt))return 'unknown';
        const generating=${JSON.stringify(STOPS)}.some(s=>[...document.querySelectorAll(s)].some(visible));
        const finished=document.querySelectorAll('[data-message-author-role="assistant"]').length>baseline.assistantMessageCount;
        if(phase==='start')return generating?'generating':finished?'finished':null;
        return finished&&!generating?'finished':null;
      };
      const initial=inspect();if(initial)return resolve(initial);
      let done=false;const finish=value=>{if(done)return;done=true;observer.disconnect();clearTimeout(timer);resolve(value)};
      const observer=new MutationObserver(()=>{const state=inspect();if(state)finish(state)});
      observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
      const timer=setTimeout(()=>finish('unknown'),${Math.max(1000, Math.min(timeoutMs, 30 * 60_000))});
    })`;
    try { return await this.evaluate<GenerationState>(expression, Math.min(timeoutMs, 30 * 60_000) + 2_000, true); }
    catch { return "unknown"; }
  }

  private async evaluate<T>(expression: string, timeoutMs = 10_000, awaitPromise = false): Promise<T> {
    const result = await this.cdp.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise, userGesture: false,
    }, this.target.sessionId, timeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "ChatGPT page evaluation failed.");
    return result.result?.value as T;
  }
}
