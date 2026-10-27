import assert from "node:assert/strict";
import {
  deriveEvidenceScope,
  evidenceSatisfies,
  evidenceSatisfiesPrivacy,
  evidenceTierRank,
  isIngressEvidenceTier,
  scopeForTier,
  tierForScope,
  tierSatisfies,
} from "./evidence-tier.js";

// --- tier ordering is strict and monotonic ---
assert.ok(evidenceTierRank("unit") < evidenceTierRank("local_integration"));
assert.ok(evidenceTierRank("local_integration") < evidenceTierRank("real_tailnet"));
assert.ok(evidenceTierRank("real_tailnet") < evidenceTierRank("public_internet"));
assert.ok(evidenceTierRank("public_internet") < evidenceTierRank("operational"));
assert.equal(tierSatisfies("unit", "public_internet"), false, "a unit test can never qualify a public claim");
assert.equal(tierSatisfies("local_integration", "real_tailnet"), false);
assert.equal(tierSatisfies("real_tailnet", "real_tailnet"), true);
assert.equal(tierSatisfies("operational", "public_internet"), true);
assert.equal(isIngressEvidenceTier("public_internet"), true);
assert.equal(isIngressEvidenceTier("internet"), false);

// --- scope is derived from the contacted origin, never asserted ---
assert.equal(deriveEvidenceScope("https://node.tail8d285a.ts.net:8443"), "tailnet");
assert.equal(deriveEvidenceScope("https://node.tail8d285a.ts.net"), "tailnet");
assert.equal(deriveEvidenceScope("https://100.101.102.103"), "tailnet");
assert.equal(deriveEvidenceScope("https://kontrol.example.com"), "public");
assert.equal(deriveEvidenceScope("http://127.0.0.1:7678"), "loopback");
assert.equal(deriveEvidenceScope("https://localhost:8443"), "loopback");
assert.equal(deriveEvidenceScope("https://[::1]:8443"), "loopback");
assert.equal(deriveEvidenceScope("https://user:secret@kontrol.example.com"), null, "credential-bearing origins are unusable");
assert.equal(deriveEvidenceScope("not a url"), null);

// --- tier follows scope; only an explicit operational receipt upgrades ---
assert.equal(tierForScope("loopback"), "local_integration");
assert.equal(tierForScope("tailnet"), "real_tailnet");
assert.equal(tierForScope("public"), "public_internet");
assert.equal(tierForScope("tailnet", { operational: true }), "operational");
assert.equal(tierForScope("public", { operational: true }), "operational");
assert.equal(scopeForTier("real_tailnet"), "tailnet");
assert.equal(scopeForTier("public_internet"), "public");
assert.equal(scopeForTier("operational", "https://node.tail8d285a.ts.net"), "tailnet");
assert.equal(scopeForTier("operational", "https://kontrol.example.com"), "public");
assert.equal(scopeForTier("operational"), null, "an operational observation without a usable origin cannot be scoped");

// --- a lower tier never qualifies a higher claim ---
assert.equal(
  evidenceSatisfies({ scope: "loopback", tier: "local_integration" }, { scope: "tailnet", tier: "real_tailnet" }),
  false,
  "a local integration test cannot qualify a tailnet claim",
);
assert.equal(
  evidenceSatisfies({ scope: "tailnet", tier: "real_tailnet" }, { scope: "public", tier: "public_internet" }),
  false,
  "tailnet evidence cannot qualify a public claim",
);
assert.equal(
  evidenceSatisfies({ scope: "public", tier: "public_internet" }, { scope: "public", tier: "public_internet" }),
  true,
);
assert.equal(
  evidenceSatisfies({ scope: "public", tier: "operational" }, { scope: "public", tier: "public_internet" }),
  true,
  "an operational observation qualifies the public claim it was collected for",
);

// --- privacy gating keeps the two sides of the boundary distinct ---
assert.equal(
  evidenceSatisfiesPrivacy({ scope: "tailnet", tier: "real_tailnet" }, "TAILNET_PRIVATE"),
  true,
);
assert.equal(
  evidenceSatisfiesPrivacy({ scope: "public", tier: "public_internet" }, "TAILNET_PRIVATE"),
  false,
  "public evidence must not qualify a tailnet-private route",
);
assert.equal(
  evidenceSatisfiesPrivacy({ scope: "tailnet", tier: "operational" }, "PUBLIC_INTERNET"),
  false,
  "an operational tailnet observation must not qualify a public route",
);
assert.equal(
  evidenceSatisfiesPrivacy({ scope: "public", tier: "operational" }, "PUBLIC_INTERNET"),
  true,
);
assert.equal(
  evidenceSatisfiesPrivacy({ scope: "public", tier: "public_internet" }, "PROVIDER_RELAY"),
  true,
);
assert.equal(
  evidenceSatisfiesPrivacy({ scope: "loopback", tier: "local_integration" }, "PUBLIC_INTERNET"),
  false,
);

console.log("evidence-tier: all assertions passed");
