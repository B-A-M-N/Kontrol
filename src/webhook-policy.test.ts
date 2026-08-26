import assert from "node:assert/strict";
import { validateWebhookUrl } from "./webhook-policy.js";

const disabled = { enabled: false, allowedHosts: [] };
assert.match(validateWebhookUrl("https://hooks.example.test/callback", disabled)!, /disabled/);

const policy = { enabled: true, allowedHosts: ["hooks.example.test"] };
assert.equal(validateWebhookUrl("https://hooks.example.test/callback", policy), undefined);
assert.match(validateWebhookUrl("ftp://hooks.example.test/callback", policy)!, /http or https/);
assert.match(validateWebhookUrl("https://other.example.test/callback", policy)!, /not in/);
assert.match(validateWebhookUrl("https://user:pass@hooks.example.test/callback", policy)!, /credentials/);
assert.equal(validateWebhookUrl("https://hooks.example.test/callback", { enabled: true, allowedHosts: ["*"] }), undefined);

console.log("webhook-policy.test.ts: all assertions passed");
