# Release contract

This document defines what it means for a Kontrol release to claim
**production stable**, the exact artifact workflow that produces one, and the
support contract that ships with it. The runtime gate machinery is shared with
the historical stable-beta naming (`gate:beta:*`, `soak:beta`); the contract
below is the product-level meaning those gates enforce.

## Maturity levels

| Level        | Meaning                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `dev`        | Any local checkout state. No qualification claims. `--allow-dirty` gates are feedback tools, never evidence.   |
| `stable-beta`| Clean candidate, full code gate, 12h soak, joined final receipt. Suitable for real use with known caveats.     |
| `production` | The stable-beta process executed against the exact published artifact, with the support contract below honored. |

The project version (`package.json`) makes no maturity claim by itself; the
qualification receipts and the published artifact identity are the claim.

## Support contract (production)

- **Supported platform:** Linux with systemd. The systemd core unit is the
  supported production lifecycle (`kontrol service`; see README "Platform
  Support" and `docs/configuration.md` service sections).
- **Development/integration platforms:** macOS and Windows (Git Bash/WSL).
  They run the same server but ship no production service lifecycle and carry
  no production qualification evidence.
- **Supported Node lines:** the `engines` field in `package.json` is
  authoritative (currently `>=22.19 <23 || >=24 <25 || >=26 <27`). A release
  is qualified on the Node version recorded in the candidate's
  `build-meta.json` (`nodeVersion`); running a different major line in
  production is outside the qualification.
- **Dependency closure:** published artifacts pin exact dependency versions
  (the qualified closure). A published `@b-a-m-n/kontrol@X` identifies one
  runtime, not whatever a range resolves to later.

## Database migration & rollback guarantees

- The candidate's `build-meta.json` records `schemaVersion`,
  `minReadableSchemaVersion`, `maxReadableSchemaVersion`, and
  `schemaCompatibility` (currently: upgrade-in-place; downgrade via
  versioned backup).
- A release must be able to open a database written by any version within its
  declared readable range and must refuse (not corrupt) outside that range.
- Rollback procedure: stop the service, restore the deployment backup taken by
  the replacement generation (`docs/configuration.md`, restart/rollback), or
  redeploy the prior immutable candidate from `releases/<buildId>/`. The
  state-directory schema is never migrated below its readable bound.

## Qualification evidence (all mandatory)

Publication is fail-closed on this evidence; `scripts/lib/release-verify.mjs`
enforces it mechanically inside the publish path:

1. **Clean checkout** at the exact commit being qualified (no dirty tree,
   ever — `--allow-dirty` output can never qualify).
2. **Code gate** — `npm run gate:beta:code` (full canonical test chain).
   Writes `beta-code-qualification.json`.
3. **Exact candidate** — the immutable build identity (`buildId`,
   content SHA, source SHA, dependency fingerprint) produced by that commit.
4. **12-hour wall-clock soak against that exact `buildId`** —
   `npm run soak:beta -- --hours 12 --build-id <buildId> ...`. Never rebuild
   between soak and publish: the soak qualifies one immutable artifact.
5. **Fresh external catalog probe** — capture one host-side `initialize` and
   `tools/list` exchange after deploying the candidate, then run
   `scripts/probe-mcp-tunnel.mjs` with `--host-catalog-file`,
   `--expected-mcp-version`, `--expected-build-id`, and `--result-file` after
   the soak ends. The probe opens a fresh server transport and fails on stale
   versions or any missing/extra invocable tool.
6. **Final joined receipt** — `npm run gate:beta:final` writes
   `beta-qualification.json` with `stage=combined, qualified=true` only when
   code receipt, soak receipt, external catalog receipt, candidate identity,
   and clean checkout all match.
7. **Release verification** — `npm run release:verify` (receipt ↔ buildId ↔
   source SHA ↔ artifact, release-local import validation, clean checkout).
8. **Staged package UAT** — the packed tarball installed into a clean prefix
   and exercised end-to-end (`npm run test:package`,
   `scripts/release-uat.mjs`).

## Exact artifact publication workflow

```bash
# 1–2. clean commit + code gate
git status --porcelain   # must be empty
npm run gate:beta:code

# 3–4. deploy the EXACT immutable buildId and soak it
npm run soak:beta -- --hours 12 --url "$KONTROL_PUBLIC_BASE_URL" --workspace-path "$PWD" --build-id <buildId> \
  --diagnostics-secret "$KONTROL_DIAGNOSTICS_SECRET" \
  --tunnel-url http://127.0.0.1:8080

# 5. capture a fresh host catalog after soak completion, then probe the same URL
npm run probe:tunnel -- --url "$KONTROL_PUBLIC_BASE_URL" --workspace "$PWD" --dual --cycles 1 \
  --watcher-timeout-ms 18000 --heartbeat-count 2 --minimum-drain-events 2 \
  --resource-load-reads 2 --diagnostics-secret "$KONTROL_DIAGNOSTICS_SECRET" \
  --host-catalog-file external-tools-list.json \
  --expected-mcp-version VERSION_PLUS_CONTENT_SHA \
  --expected-build-id <buildId> \
  --result-file beta-external-catalog.json

# 6. join the receipts
npm run gate:beta:final

# 7. verify the qualified candidate
npm run release:verify

# 8. publish the exact qualified artifact (never rebuilds)
KONTROL_QUALIFIED_CANDIDATE=releases/<buildId> \
KONTROL_RELEASE_BUILD_ID=<buildId> \
npm run release:publish
```

Direct `npm publish` from the checkout is refused (`prepublishOnly`) — the
staged path above is the only way to publish. Every bypass scenario
(missing/unqualified/code-only/interrupted receipts, buildId or SHA mismatch,
missing candidate, dirty checkout, rebuild attempts) is proven to fail closed
by `src/release-publish.test.mjs`.

## Upgrade / rollback procedure

1. **Upgrade:** install the new published artifact, stop the old generation,
   start the new one (systemd unit or `kontrol serve`); the replacement
   generation verifies readiness and restores the validated backup +
   previous unit if any readiness stage fails.
2. **Rollback:** stop the new generation, restore the deployment backup (or
   redeploy the prior `releases/<buildId>`), restart. Because published
   dependency closures are exact and state schema bounds are recorded, a
   rollback target runs against the same database layout it wrote.

## Release gate aliases

The stable-*beta* scripts are the implementation; the *release* names are the
product-facing contract. Currently `gate:release:code`, `soak:release`, and
`gate:release:final` are aliases of the beta machinery — the evidence
requirements are identical, only the maturity claim differs.
