# Kontrol multipath ingress — remaining work

Updated: 2026-10-26 (sixth revision)
Repository: `/home/bamn/devspace`
Branch: `audit-k02-k04`
Starting HEAD for this revision: `44c247a`. The change is the range
`44c247a..HEAD` - the local commits listed below.
Commits are local only. Do not push without separate authorization.
Preserve untracked `.tmp-scratch/`.

## Local commits (not pushed)

These commits are local only; nothing was pushed. The table has one row per
commit of this change, the last row being the documentation commit itself;
no count is stated in prose, because every documentation commit would have
to restate a number that its own commit changes.

| # | Commit | Subject |
|---|--------|---------|
| 1 | `37e7bb5` | `fix(mcp): deliver catalog notifications only on a live SSE surface` |
| 2 | `c1614a6` | `fix(hermes): give the relocated interpreter its runtime root in the sandbox` |
| 3 | `bf37f2e` | `fix(ingress): never report an unproven route as tailnet-private` |
| 4 | `072771a` | `test(chain): execute every test file from the canonical chain` |
| 5 | `e5a07c8` | `docs: record the contracts, the origin decision and the continuation record` |
| 6 | `1e983ed` | `docs: correct the round-7 review row and record the round-13 residuals` |
| 7 | `f6dcfa1` | `docs: map the changed-files table one-to-one onto the change` |
| 8 | `3859026` | `docs: state the round-9 tally and cite the final full-chain run` |
| 9 | this commit | `docs: name the reviewed range and distinguish the two handoff records` |

Requirement source:
`/home/bamn/.codex/attachments/458e9b15-a1ec-4247-aa20-19ec878f9be9/pasted-text-1.txt`

Items 1–4 of the previous revision are unchanged in substance. Item 5 (the
pre-existing failing unit test) and item 3 (the public origin decision) are
now implemented, and item 6 (the operator checklist) has been executed.

---

## What this pass completed

### 1. The pre-existing failing unit test is fixed (previous item 5)

`src/mcp-tool-catalog-http.test.ts` failed at

> release B sends the supported tools/list_changed refresh pulse over the
> existing GET stream

It is fixed at the root cause; the assertion was not weakened.

**Root cause.** `sendCatalogRefreshPulse` treated a resolved transport send
as a *delivered* notification. The MCP SDK streamable-HTTP transport silently
drops a server-initiated notification when no standalone GET SSE stream is
attached, and it still resolves the send. The `initialized`-phase pulse
therefore ran before the host opened its GET stream, "succeeded", and marked the
tools/resources channels sent. The later `get_stream` pulse — the one that
runs while the stream is attached — was skipped as `already_sent`, so the
notification never reached the host.

**Fix** (`src/server/mcp-http.ts`, `src/server/catalog-refresh.ts`,
`src/server/mcp-session-state.ts`, `src/server/diagnostics.ts`). A
channel counts as successful only when a live standalone GET SSE stream can
carry it, and the delivery state belongs to the stream that carries it.

1. **No stream, no send.** A pulse attempted while no standalone GET SSE
   channel exists is counted in `deferredNoStreamAttempts`, logged as
   `mcp_catalog_refresh_deferred`, and returns without consuming a send
   attempt. The channel stays eligible; the GET-stream phase delivers it.
2. **The delivery surface has an owner.** The request that establishes the
   standalone stream (the GET whose SSE headers the transport writes, after the
   SDK registered the stream) owns the surface, and only that request may clear
   it. A rejected duplicate GET - the SDK answers 409 while a standalone
   stream exists - therefore cannot tear down a live surface.
3. **The surface's state is re-armed when it ends.** The sent flags, the
   attempt counters and the backoff timestamps are reset when the owning stream
   ends, so a success recorded against a stream that has since disappeared can
   never suppress the notification on the next standalone stream.
4. **A delivery that outlives its stream is not a delivery.** Every send
   captures the surface identity (`deliveryGeneration`). If the send
   resolves after the surface ended, the outcome is `stale`: the channel
   is not marked sent, the success is not counted, the bounded retry budget is
   not consumed, and a live successor surface is paid the notification
   immediately instead of at the next pulse opportunity.

A channel that was really delivered is still never resent for the same session
refresh state, and failed channels keep their bounded retry/backoff.

**Proves it.** The assertion passes; six independent mutations of the fix are
each killed by a named assertion (table below); and the whole
`npm run test:unit` chain runs to completion (`EXIT=0`), which the
previous revision could not do.

| # | Mutation | Killed by |
|---|----------|-----------|
| M1 | the no-stream deferral gate removed | a pulse attempted before any GET stream existed is recorded as deferred |
| M2 | the re-arm removed | a finished standalone stream re-arms the delivery so its success cannot suppress the next stream |
| M3 | the `already_sent` guard removed | a delivered channel is never resent for the same session refresh state on the same standalone stream |
| M4 | the stale discard removed | a send that resolves after its delivery surface ended is not a success |
| M5 | both delivery guards removed | release B sends the supported tools/list_changed refresh pulse over the existing GET stream (only heartbeats received - the original pre-fix failure) |
| M6 | the retry-budget rollback removed | a stale delivery does not consume the retry budget of the next surface |

### 2. The public origin mode is decided (previous item 3)

Audit P1-06 is answered in `docs/ingress.md` ("Public origin mode
decision (audit P1-06)"): this deployment uses **Mode A — stable public
identity**. The owned domain behind the public HTTPS bridge is the single
canonical owner-facing OAuth origin; ingress backends (bridge, Funnel,
optional WireGuard upstream) sit behind it and are selected by DNS, routing,
and health checks, never by the client. The MCP resource identity therefore
stays stable and a backend failover is transparent to the client.

The decision is machine-checked, not only written down:
`src/ingress/validate.ts` already fails closed when an *enabled*
`owner_public` profile names any other origin (disabled standby profiles
are exempt).

Mode B stays the explicit recovery option through
`scripts/mcp-owner-stdio-bridge.mjs`, which requires an endpoint-specific
owner-only bearer file and an exact resource identity per origin, refuses to
reuse one origin's credential for another, and makes the client reauthorize
when it switches origins. No bearer credential is ever shared across origins
and OAuth resource checks are not weakened.

### 3. Operator checklist and qualification matrix (previous item 6)

See "Verification evidence" below. The qualification matrix now reports **12
pass, 6 `source_verified`, 0 unverified, 0 failed** when the Caddy binary
is selected; the previous revision reported 11 pass, 6 `source_verified`,
1 unverified.

### 4. A real Hermes provider run (this pass, beyond the previous item list)

The scheduled read-only audit was exercised against a real Hermes provider
end to end. Getting there exposed four genuine defects, all fixed in this
pass. The fourth was found later, by the secondary review of this diff.

**Defect 1 - the confined interpreter could not find its own standard
library.** The Hermes ACP launcher is a console script whose shebang points
at a relocated CPython (the upstream Hermes runtime keeps its own interpreter
generation under `.hermes-runtime/python/generation-*`). Inside Bubblewrap
the interpreter was bound at `/opt/kontrol/hermes-bin/python` with no
`PYTHONHOME`, so it could not locate `lib/pythonX.Y` and the launcher
failed with an empty module search path:

    Could not find platform independent libraries <prefix>
    No module named `acp_adapter`

`scripts/acp-hermes-native-adapter.mjs` now resolves the selected
interpreter runtime root and passes it as `PYTHONHOME` to the launcher
preflight, the runtime probe and the worker launch. The root is only used
when it really contains a Python standard library, so a wrapper script that
merely points at the system interpreter (the e2e fixture) is unaffected.

**Defect 2 - a host-networked run could not resolve names.**
`buildReadOnlySandboxCommand` bound the TLS trust store and
`nsswitch.conf` but never `/etc/resolv.conf`. A run with
`networkPolicy: "host"` therefore had a network namespace it could not
resolve names in, and the provider call failed with
`APIConnectionError: Connection error` / Hermes can not reach the model
provider. The resolver configuration is host state, not a secret, and it is
now bound read-only **only** when the caller explicitly opted into host
networking; a run without it still observes no host resolver at all.

Both fixes are covered by assertions in
`src/read-only-execution.test.mjs` and
`src/hermes-native-adapter.test.mjs`.

**Defect 3 - a shipped script could import a module the package does not
ship.** The Hermes adapter now resolves its interpreter runtime root through
a shared module (`scripts/lib/hermes-python-runtime.mjs`) and scrubs its
launcher stderr through a second shared module
(`scripts/lib/adapter-diagnostics.mjs`). Adding either module exposed a
packaging gap that had been latent since the external-qualification work:
`package.json` declares the files the published tarball contains, and a
shipped script that imports a sibling module which is not on that list
installs cleanly and then dies with `ERR_MODULE_NOT_FOUND` in the clean
install, on the operator machine.

The gap was pre-existing and unrelated to the two new modules:
`scripts/probe-ingress-bridge.mjs` shipped without
`scripts/lib/mcp-qualification-evidence.mjs`. That module is now declared,
and `src/package-files-manifest.test.mjs` is a new guard that resolves every
relative import of every shipped script, transitively, against the declared
file list. The guard is mutation-killable: removing one declared entry from
the list makes it fail.

**Defect 4 - a probe failure message carried raw child stderr into a
scheduled-job receipt.** The launcher preflight was already scrubbed, but the
*runtime* probe - the second, Python-level import check inside Bubblewrap -
still put `runtimeProbeResult.stderr` into the thrown
`sandbox_unavailable` message. That message is returned as the 503 body
and is projected into the scheduled-job receipt, so a Python traceback (which
can echo a profile path, an environment value, or an authorization header)
reached a durable record. Both probes now report a stable category only
(`timed_out`, `spawn_failed`, `terminated_without_status`, `exit_<status>`); the
bounded stderr and the spawn error go to the adapter log, scrubbed by
`scripts/lib/adapter-diagnostics.mjs`. The rule is asserted in
`src/adapter-diagnostics.test.mjs` (the category carries no path, no
stderr and no credential material) and in `src/hermes-native-adapter.test.mjs`
(neither probe message contains stderr or a raw detail).

**Result.** An isolated core and a dedicated Hermes adapter instance ran a
`read_only_audit` scheduled job against the real Nous provider
with `networkPolicy: "host"`. The receipt:
`workerCompleted: true`, `executionStatus: "completed"`, `reportAvailability: "available"`, and an
immutable report whose SHA-256 is
`4e9347725099308aea466b8e3aa7d7ae450cc41516cdd1e077d50fb7593a65f4`.
The report body is the provider's own answer to the task, not a
Kontrol-authored string.

**Operator note.** The Nous Portal grant in the Kontrol read-only profile
(`KONTROL_HERMES_SANDBOX_HOME`) had expired on 2026-10-20 and its refresh
token was already rejected, so the confined run could not authenticate. The
profile is refreshed from the operator live Hermes store, not by the
adapter: copy the live `auth.json` and `config.yaml` into a directory
that contains **only** those two files and point
`KONTROL_HERMES_SANDBOX_HOME` at it. The adapter rejects a profile
directory that carries anything else.

### 5. Review follow-ups closed (this pass)

All five open P2 review follow-ups were inspected, and all five are now
addressed.

| Follow-up | What it recorded | Resolution |
|-----------|------------------|------------|
| `404e6c94` | Four PR-C round-5 residuals: an unguarded POSIX-only spawn tripwire, a quoted-binary ban with a backtick hole, an unasserted `FUNNEL-EXPOSED` marker, and a serve-side funnel attribution that failed open under upstream shape drift | All four are fixed in this branch; the table below gives the code-level fix |
| `255f8545` | The canonical `npm test` does not execute the new review-loop fixtures | The four review-loop suites this branch has now run inside `test:unit`, and the manifest check now proves execution instead of reachability, so the gap cannot silently reopen |
| `747b2ed3` | The same composition finding in detail. It names three fixtures that exist only on `handoff/integration-candidate` (`src/review-browser-handoff-integration.test.ts`, `src/review-browser/browser-restore-cleanup.test.ts`, `src/ui/review-thread-event-trigger.test.ts`) | Closed for this branch: those three files are not in this branch's tree, and the equivalent suites this branch does have are now executed by the canonical chain (section 6) |
| `1fc32cff` | The verdict record of that same composition review (APPROVE, one non-blocking observation) | Closed with the composition finding it covers: the canonical chain now executes every test file in the repository |
| `4e4c4ea0` | Two style observations from an independent review of the composed candidate: a missing rationale for the activation tools not taking a mutation receipt, and a supposedly redundant nullish coalescing in the delivery loop | Both are answered on the equivalent code in this branch: `src/bridge/handoff-tools.ts` now states why the one-time activation grant is the idempotency fence, and `src/ui/review-thread-delivery.ts` now states that its default is a host-boundary guard rather than a redundant coalescing |

The two substantive residuals were fixed at the root cause:

| Residual | Fix |
|----------|-----|
| The POSIX-only spawn tripwire in `src/cli.test.ts` broke the Windows leg unguarded | The tripwire is now guarded by `process.platform === "win32"`, following the repository convention, and the rest of the suite still runs everywhere |
| The quoted-binary ban in `src/cli.test.ts` had a backtick hole | The ban now covers the single-quoted, double-quoted and backtick forms, and the pattern was checked against the bare name and longer words so it does not false-positive |
| The human-view `FUNNEL-EXPOSED` marker was unasserted | `src/ingress/profile-status.test.ts` now asserts that the observed route carries the exposure flag the marker is derived from, and that a tailnet-private route does not |
| Serve-side funnel attribution failed open under upstream shape drift: with `allowFunnel` undefined on every route the classifier still reported a positive match | `src/ingress/tailscale-status.ts` now unions the exposure attribution of both status documents, recovers a renamed exposure field only when its name still identifies it as the funnel attribution, and refuses to read an unreadable one; a boolean HostPort map under any other name leaves the exposure unproven instead of being guessed; `src/ingress/profile-status.ts` reports `UNKNOWN` instead of `MAPPING_MATCHED` when a route's exposure is unproven |

The last one is a real fail-open in a public-exposure check, and it is
mutation-killable: removing the `UNKNOWN` return makes the new assertion
fail. The two remaining follow-ups describe review-loop code that is not in
this branch (the commits they reference are on other branches), so they
were inspected and left open for the branch that owns them.

### 6. The canonical chain now executes every test file

The manifest check only proved *reachability*: that a test file was mentioned
by some `package.json` script or by the UI runner. A suite that only a
standalone script runs protects no release, and the repository had **13** of
them. This was reproduced against the committed tree rather than estimated:
the upgraded check, run against `HEAD`, names all 13.

| # | Suite that was never executed | Now executed by |
|---|------------------------------|-----------------|
| 1 | `src/review-thread/review-thread.test.ts` | `test:unit` |
| 2 | `src/review-thread/review-thread-mcp.test.ts` | `test:unit` |
| 3 | `src/ui/review-thread-delivery.test.ts` | `test:unit` |
| 4 | `src/review-browser/contracts.test.ts` | `test:unit` |
| 5 | `src/mcp-inspection-output.test.ts` | `test:unit` |
| 6 | `src/pi-tools-read-snapshot.test.ts` | `test:unit` |
| 7 | `src/qualification/external-catalog-capture.test.ts` | `test:unit` |
| 8 | `src/scheduling/scheduled-artifact-publisher.test.ts` | `test:unit` |
| 9 | `src/server/mcp-qualification-evidence.test.ts` | `test:unit` |
| 10 | `src/workspace-app-resource-registry.test.mjs` | `test:unit` |
| 11 | `src/ui/connection-lifecycle.bootstrap.test.ts` | `test:ui`, through `scripts/run-ui-tests.mjs` |
| 12 | `scripts/probe-mcp-tunnel-failure.test.mjs` | `test:syntax` |
| 13 | `scripts/lib/probe-failure-receipt.test.mjs` | `test:syntax` |

The check itself was upgraded from reachability to execution. It resolves the
chain the canonical test script actually runs - the `package.json` script
bodies, the runner scripts those bodies spawn, and the script arrays those
runners really RUN - and fails when a suite is outside that chain. A suite
path counts only when it reaches a process in an executable position, so a
mention, a log message and an environment value are not executions
(section 9). The four
allowlist entries that used to hide four of the 13 were stale (their stated
reasons - "requires external host capture evidence", "deliberate manual
fixture" - were not true of the suites) and are gone; the allowlist is now
empty, and an entry that is no longer needed is itself a failure.

**Proves it.** The check reports `198 test files all executed by the
canonical chain` (14 scripts, 26 runners). It is mutation-killable:
removing one suite from `test:unit` makes the check name that suite and exit 1.

### 7. The check proves execution, not a mention

The first version of the upgraded check still accepted a *mention*: any
occurrence of a suite path inside the closure counted. A comment, a
self-referencing `console.log` line, or a `node --check` parse would
therefore have marked a suite as executed while nothing ran it. A secondary
review found this (P2), and it is now closed.

Execution is proven by an invocation context only:

- an interpreter command in a `package.json` script body
  (`node`, `tsx`, `npx tsx`, `python3`), or
- an argument of a call inside a runner the chain spawns that really starts a
  process (`runTsx([`"src/x.test.ts"`])`, where `runTsx` itself calls
  `spawnSync`).

Comments are stripped before the scan and `node --check` is excluded
because it parses a file instead of running it.

### 8. The check proves a process starts, not that a name sounds like one

The rule above was still too weak in two places, and the second secondary
review of this diff found both. They are now closed.

**A script-name array must reach a spawn.** A runner that declares the
scripts it runs and then only *logs* their names proves nothing, yet the
first version of the check accepted it, so the closure widened and every
suite behind the named scripts was counted as executed while no release gate
ran it. The name now has to reach a process: the array counts only when a
spawn-shaped call receives it, or when the loop variable that carries it is
passed to such a call - directly or through a local function that spawns.

**A call only spawns when it reaches `node:child_process`.** A helper
whose name merely sounds like a spawn (`invokeWebhook`, `runSuite`) is
not a spawn, and a runner that cannot spawn at all cannot execute a suite,
whatever its helpers are called. The check now requires the call to reach the
`node:child_process` API, directly or through a local function that does, and
a runner that does not import it (directly or through a local module) never
counts an execution.

`src/test-manifest.test.mjs` is the regression test for both rules. It runs
the check against synthetic fixture trees and asserts that a wired suite
passes, an unwired suite fails, a commented-out suite fails, a
self-referencing suite fails, a spawned suite passes, a documented exclusion
passes, and a stale or dead exclusion fails - and that a script array which
is only logged, only printed, or owned by a runner that cannot spawn does
**not** widen the closure, that a spawn-shaped name that never spawns is not
an execution, and that a script array the runner really spawns (directly or
through a local helper) does widen it.

**Proves it.** Eight independent mutations are each killed: the logged
array, the printed array, the unspawnable runner and the fake spawn-shaped
name each make the check fail, and the directly spawned array, the array
spawned through a local helper, the spawned suite and the wired suite each
make it pass. Run against the committed `HEAD` tree, the check still names
exactly the same 13 suites.

### 9. A path in a log message is not an execution

The third secondary review of this diff found the check still counting
*data* as an execution, and the ingress recovery still guessing. Both are
now closed.

**A call quoted inside a string literal is not a call.** The scan matched
`spawnSync(` inside a log message, so

    console.log("see spawnSync(process.execPath, [src/x.test.mjs])");

counted `src/x.test.mjs` as executed while nothing ran it. The scan now knows
where the string literals are and skips every match inside one.

**A path has to reach the process in an executable position.** The check
counted any string literal inside the arguments of a spawn-shaped call, so
a path carried in an environment value or an options object — data the process
reads, naming no program — counted as an execution. Only an argument that IS the
path, or a direct element of the argument-vector array, counts now.

**A spawn helper in an imported local module is real code.** The call graph
followed only the functions a runner declares itself, so a runner whose spawn
helper lives in an imported module was rejected: a false negative that would
have hidden real wiring. The graph now follows the local imports.

**The exposure attribution is no longer guessed.** A renamed exposure field
was recovered "by shape": any top-level boolean HostPort map was accepted.
Shape alone cannot tell a renamed exposure map from an unrelated one —
`SomeFutureMap: {"node.ts.net:443": true}` was read as "this route is
public" — so the recovery is now limited to a field whose name still
identifies it as the funnel attribution, and an unidentifiable map leaves the
exposure unproven instead of guessed in either direction.

**The documentation said per-route; the code is per-profile.** Attribution
completeness is a property of the union of both status documents, so an
unattributable or contradicted exposure signal withholds the positive match
for every route of the profile, not only for the route it concerns. The
documentation now says exactly that.

**Proves it.** Seven further mutations are each killed: a call quoted inside
a log message, a path carried in an environment value, an imported helper
ignored again, a runner allowed to spawn without importing
`node:child_process`, an unrelated boolean map read as the exposure
attribution again, an unrelated map ignored again, and a renamed field with
an unreadable shape read as no exposure again.

### 10. A shell comment is not a command, and a flag value is not a program

The tenth secondary review of this diff found one P1, three P2 and one P3
besides a documentation note. All are closed.

**A shell comment ran a suite that never ran (P1).** The check stripped
JavaScript comments from a runner but never stripped shell comments from a
`package.json` script body, so

    "test": "node src/executed.test.mjs # node src/orphan.test.mjs"

marked the orphan as executed while `sh` ran nothing after the `#`. This is
exactly the class of hole the check exists to prevent, on the other side of
the file from the one that was fixed before. Shell comments are now stripped
once, in the one place a script body is read, and the strip is
quote-aware: a `#` inside a quoted string, or inside a word such as
`path#fragment`, is literal text and does not start a comment. A commented-out
`npm run` widens neither the closure nor the executed set either.

**Only the first positional argument is the program (P1, same root).** The
check treated every token after the interpreter as an executable position, so
a flag value that named a suite counted: `node --config src/x.test.mjs` reads
the file as a configuration, it does not run it. In a script body only the
first positional argument is the program the interpreter runs; a flag value
(`--config`, `--import`, `--env-file`, ...) and an argument after the program
are data the program reads, so a path there names no program. An interpreter
that evaluates its program inline (`node -e`) runs no file at all.

**An unproven exposure yielded a positive MISMATCH (P2).** The classifier
withheld the positive match under an incomplete exposure attribution, but it
then fell through to the mismatch branch and reported `MISMATCH` - a positive
finding derived from a dropped exposure signal. A route that may be
publicly exposed because its attribution could not be read is not "a
different route"; it is unknown. The completeness of the attribution now
gates the classification in both directions, and it does so before the
mismatch branch.

**An unreadable HostPort key was skipped, not refused (P2).** The exposure
map reader skipped an entry whose key was not a recognizable HostPort and
still returned the rest as readable, so a funnel-enabled route whose key
upstream renamed read as a route with no exposure at all - the same
"shape drift reads as private" failure, through the key axis instead of the
value axis. A key that cannot be normalized now makes the whole map
unproven.

**The Hermes adapter carried undeclared feature hunks (P2).** The adapter
diff contained `context_transfer` handling and a `providerSessionScope`
helper that belonged to no declared slice, had no test coverage, and
weakened a fail-closed gate: the `continuation_session_missing` refusal was
relaxed to allow a continuation without a persisted provider session, and the
scope key forked on a client-supplied packet hash. These hunks have been
reverted from this change. The adapter now differs from `HEAD` only by the
declared `PYTHONHOME` runtime root, the scrubbed probe diagnostics and the
stable probe-failure category.

**The dead helper and the uncovered backoff restore (P3).** An unused
`firstBoolean()` was removed. The backoff-timestamp restore on a discarded
stale delivery was defensible but unobserved, so it is now asserted
directly, with the narrowing that keeps it from resurrecting a timestamp on a
freshly re-armed surface.

**Proves it.** Seven further mutations of the shell-comment and
executable-position rules are each killed (no strip at all; a `#` anywhere
rather than at a word start; the executable-position rule reverted; a flag
value read as the program; an inline program read as a file; the `npm run`
closure reading the unstripped body; a quoted `#` starting a comment), and
three further mutations of the ingress and catalog-refresh guards are each
killed (an unreadable HostPort key skipped instead of refused; the mismatch
branch reached under an unproven attribution; the backoff-timestamp restore
dropped).

---

### 11. The eleventh review confirmed every round-10 fix, and its two residuals are closed

The eleventh secondary review of this diff returned **approve**: it
reconstructed the reviewed tree from `git archive HEAD` plus the patch, and
confirmed from the code - not from the claims - that all six round-10
findings were genuinely closed: the shell-comment strip happens in the one
place a script body is read; only the interpreter's first positional argument
is the program; the attribution-completeness gate precedes both the
exact-match and the mismatch branch; the HostPort map is refused as a whole
when a key will not normalize; the undeclared `context_transfer` hunks are
gone from the Hermes adapter; and the dead helper is gone while the
backoff-timestamp restore is asserted. It raised no P0, P1 or P2 finding.

It left two P3 residuals, and both are now closed here.

**The manifest guard recognized only one import form (P3).** The check
resolved relative imports with two regular expressions that matched a
double-quoted, single-line `from "` and a double-quoted
`import("...")`. A shipped script that imported a sibling with a single
quote, over several lines, as a side-effect import, or as a dynamic import
with an options argument was not seen at all - and a sibling module that is
not on the declared file list is exactly what this check exists to catch,
because it installs cleanly and then fails with `ERR_MODULE_NOT_FOUND` on
the operator machine. The check is now a scanner rather than a pattern: the
specifier of an import is whatever string literal follows the import or
export keyword, in any quote style and on any number of lines, while a
commented-out import is not an import and a path that is only data - inside
a log message - names no module. The scanner asserts its own behavior
against sixteen fixtures, so the guard's correctness is checked rather than
assumed.

**An interpreter flag the checker could not classify was guessed (P3).** The
set of flags known to consume the argument that follows them was hardcoded,
and a flag outside it was assumed not to consume one. For a flag that does
consume one - `tsx --tsconfig cfg.json suite.test.ts` - the checker then
read the configuration path as the program and missed the suite behind it.
That direction fails loudly rather than silently, but it is still a guess,
and a guess is the wrong basis for a release check. The checker now refuses
to guess: an unclassified flag fails the check and names the flag and the
command it appeared in, with the two ways to classify it. The rule found a
real case the moment it was enabled - `python3 -m py_compile`, where the
value of `-m` names the program rather than data, which is why a module
flag is a third category of its own.

**Proves it.** The old manifest guard and the new one are run against the
same six fixtures: the old one passes four cases that ship an undeclared
sibling module (single-quoted, multi-line, side-effect and
dynamic-with-options imports) and the new one fails all four, while both
fail the two cases the old one already caught. Four mutations of the new
flag rule are each killed: the unclassified-flag branch removed, the
module-flag branch removed, the unclassified-flag report removed, and the
boolean-flag set emptied.

**A module flag cannot tell a runner from a reader (P3, noted).** The
twelfth review confirmed both round-11 closures with its own fixtures and
raised no P0, P1 or P2 finding. Its one P3 is the direction the module flag
takes: the paths after `python3 -m <module>` are arguments to that module,
and the checker cannot tell a module that RUNS its arguments (pytest) from
one that only reads them (`py_compile`), so a suite reachable only through
a module flag is reported as unexecuted rather than credited. That is the
fail-closed direction - it demands a human look instead of asserting an
execution - and it is now stated in the contract. No script in the canonical
chain uses a module flag except `python3 -m py_compile`, which compiles a
file rather than running it.


### 12. Round 13 reviewed the committed state, and its two P3 residuals are closed

Round 13 was the first review of the **committed** change rather than of a
working tree. It reconstructed `44c247a..e5a07c8` with `git archive` into its
own scratch directory and worked there, because the shared checkout is edited
concurrently and its working state is not the state under review. It returned
approve with no P0, P1 or P2 finding, and two P3 residuals.

What round 13 verified, from the code rather than from the prose:

- the change is exactly 34 files, and `git diff --name-only 44c247a..HEAD`
  matches the reviewed file list exactly. At the time of round 13 the range
  was `44c247a..e5a07c8`; every commit after it changes only `handoff.md`,
  which is already in that set, so the range and the file count are unchanged;
- each of the five commits contains only files that belong to its stated
  subject, and neither `.tmp-scratch/` nor the generated
  `ingress-qualification-matrix.json` is in any commit;
- the two intermediate `package.json` blobs - the Hermes commit and the
  canonical-chain commit - each parse as JSON and carry valid `scripts`;
- `node scripts/test-manifest.mjs` reports "198 test files all executed by the
  canonical chain (14 scripts, 26 runners)"; `node src/test-manifest.test.mjs`
  and `node src/package-files-manifest.test.mjs` exit 0; and
  `npx tsc -p tsconfig.json --noEmit` is clean;
- `src/ingress/tailscale-status.test.ts`, `src/ingress/profile-status.test.ts`
  and `src/server/catalog-refresh.test.ts` pass against the reconstructed tree,
  re-run for this record;
- the manifest scanner finds a single-quoted, multi-line, side-effect,
  dynamic-with-options and export-from import of an undeclared sibling module,
  and ignores a commented-out import and a path that is only data - the
  sixteen-fixture behaviour `src/package-files-manifest.test.mjs` asserts.

**P3 (a): the round-7 row contradicted the round-9 and round-10 rows.** The
round-7 row still said its two P3 findings "are nits and are not addressed in
this pass", while the round-9 and round-10 rows recorded both as closed - the
shape-recovery scan in section 9, the backoff-timestamp rollback comparison in
section 10. The round-7 row now says that both were accepted as nits at the
time, left open in that round, and closed in the later rounds.

**P3 (b): the Workspace App artifact prerequisite was not recorded.** The
suites that start the server resolve the Workspace App artifact at startup, so
they need a built artifact. Re-checked directly for this record: in a bare
source tree with no `dist/ui/workspace-app.html`,
`src/mcp-tool-catalog-http.test.ts` fails at startup with the resolver's own
error - "No built Workspace App artifact found" - and with
`KONTROL_WORKSPACE_APP_HTML_PATH` pointed at a built artifact it passes
("strict-mode handshake passed"). This is an environment prerequisite, not a
defect: the canonical chain supplies it, because `scripts/run-runtime-tests.mjs`
builds the app into a temporary artifact directory and points that variable at
the build. It is now recorded in the environment notes below.


## Still missing — operator-gated deployment evidence

### A. Real tailnet deployment evidence

Status: still missing. The tooling is complete; the remaining steps need
tailnet-admin state and deployment state that does not exist on this host.

Facts verified on this host on 2026-10-25:

- `tailscale serve --bg --https=8443 http://127.0.0.1:<port>` prints
  "Serve is not enabled on your tailnet" and prints the enable URL
  `https://login.tailscale.com/f/serve?node=naxcGFPJk321CNTRL`. Enabling
  it is a browser action in the tailnet admin account. This host has no
  Tailscale API credential and the installed CLI has no `api` subcommand,
  so the toggle cannot be flipped from the shell.
- The deployment has **no ingress profile and no peer listener**: the live core
  runs with `KONTROL_AUTH_MODE=tunnel` and no `KONTROL_INGRESS_PROFILES`
  and no peer settings, and `kontrol ingress inspect --json` reports
  `profiles: []`.
- A second tailnet node is reachable and usable as the probing client:
  `ssh pop-os-1` works (`pop-os-1.tail8d285a.ts.net`, a node distinct
  from the serving node `pop-os.tail8d285a.ts.net`).

Steps:

1. An operator enables Serve on the tailnet at the URL above.
2. Enable the peer listener, enroll a peer principal, and write its mode-0600
   credential registry file (`KONTROL_PEER_CREDENTIAL_FILE`).
3. Configure the profile:

   ```json
   {"id":"serve-peer","kind":"tailscale_serve","audience":"peer",
    "externalOrigin":"https://pop-os.tail8d285a.ts.net:8443",
    "target":"peer_listener","enabled":true,"managedByKontrol":true,
    "allowedHosts":["pop-os.tail8d285a.ts.net:8443"]}
   ```

4. Apply it through the receipt-backed controller (never by hand):

   ```sh
   kontrol ingress apply serve-peer --confirm
   ```

5. From the **second tailnet node** (not the serving node), qualify the route:

   ```sh
   npm run probe:serve -- --url https://pop-os.tail8d285a.ts.net:8443 \
     --authorization-file /path/to/peer-bearer --profile-id serve-peer \
     --state-dir ~/.local/share/kontrol --build-id "$BUILD_ID"
   ```

6. Feed the evidence into the matrix:

   ```sh
   npm run qualify:ingress -- --evidence-state-dir ~/.local/share/kontrol
   ```

**Proves it:** `serve-mapping-exact-match` moves from `source_verified` to
`pass` at the `real_tailnet` tier, and the recorded observation carries the
build id, observed route, principal class, session identity hash, operation id,
and failure class. The same Serve route also unblocks
`forged-forwarded-and-x-kontrol-headers` (a tailnet client forging authority
headers at the real route) and the tailnet half of
`sse-idle-timeout-and-45s-post`.

### B. Public-internet deployment evidence

Status: still missing; no public origin exists and none can be created from
this host (no cloud CLI, no domain, no Tailscale Funnel capability).

Three matrix rows remain `source_verified` at the `public_internet` tier
(`funnel-public-authenticated`, `forged-forwarded-and-x-kontrol-headers`,
`sse-idle-timeout-and-45s-post`), plus `funnel-removed-during-sse`. They
need a non-tailnet client against a public origin. Either:

- **Tailscale Funnel** on this host (`tailscale funnel`) — also requires the
  tailnet to have Funnel enabled, and it publishes the node to the public
  internet, so it needs explicit operator authorization; or
- **the public HTTPS bridge** described in `deploy/bridge/README.md`: a VPS with
  its own domain running Caddy, proxying to a private Serve upstream.

Bridge path:

1. Deploy the VPS per `deploy/bridge/README.md` and copy the **packaged**
   `deploy/bridge/Caddyfile.example` (not a source-tree copy).
2. Validate the deployed configuration and record the receipt:

   ```sh
   node scripts/qualify-caddy-bridge.mjs --config /etc/caddy/Caddyfile \
     --bridge-node <tag:kontrol-bridge> --public-host kontrol.example.com \
     --upstream <node>.<tailnet>.ts.net:9443 --build-id "$BUILD_ID" \
     --receipt /var/lib/kontrol/caddy-qualification.json
   ```

3. Prove route isolation against the **deployed** file:

   ```sh
   node scripts/bridge-route-isolation.mjs --config /etc/caddy/Caddyfile \
     --build-id "$BUILD_ID" --receipt /var/lib/kontrol/bridge-isolation.json
   ```

4. Qualify the public origin from a **non-tailnet client**:

   ```sh
   node scripts/probe-ingress-bridge.mjs --url https://kontrol.example.com \
     --authorization-file /path/to/oauth-bearer --workspace-path /path/to/ws \
     --long-post-ms 45000 --profile-id bridge-1 \
     --state-dir ~/.local/share/kontrol --build-id "$BUILD_ID"
   ```

**Proves it:** those rows move to `pass` at the `public_internet` tier.

### C. External TLS or DNS failure classification

Status: still missing; depends on B.

`external-tls-or-dns-failure` needs a real external TLS or DNS failure
observed through the public origin (an expired or wrong-host certificate, or a
DNS failure), captured as a profile-specific failure classification. The
tooling already records honest failure evidence — a probe against an unmapped
route produced `state: DOWN`, `evidenceTier: real_tailnet`,
`failureClass: route-identity-exact` — but that is a synthetic failure,
not an external TLS/DNS failure.

**Proves it:** an observation whose `failureClass` names the specific
external failure (not a route mismatch), captured from the public origin.

---

## Review rounds

The fix was reviewed thirteen times, each round in a fresh session that did not
write the code. Every round was against the complete diff, not a summary.
Round 6 covered the whole diff, including the Hermes sandbox changes and
the documentation, which rounds 1-5 had not seen. Round 7 reviewed the
whole diff again after the documentation was written, and its two P2
findings are closed in sections 4 and 7. Round 8 reviewed the whole diff a
third time, after the manifest check was hardened, and its one P2 and the two
actionable P3 findings are closed in section 8 and in
`src/ingress/tailscale-status.ts`. Round 9 reviewed the whole diff a
fourth time, after the check was hardened again, and its one P1, three P2 and
three P3 findings are closed in section 9 and in the documentation. Round 10
reviewed the whole diff a fifth time, after the round-9 fixes, and its one P1,
three P2 and one P3 findings are closed in section 10. Round 11 reviewed the
whole diff a sixth time, after the round-10 fixes, and returned approve: it
confirmed all six round-10 findings closed from the code, and its two P3
residuals are closed in section 11. Round 12 reviewed the whole diff a
seventh time, after the round-11 fixes, and returned approve again with no
P0, P1 or P2 finding; its one P3 is the direction the module flag takes and
is recorded in section 11. Round 13 reviewed the committed state - the five
commits that existed at that point - rather than the shared working tree,
confirmed that the committed bytes are the reviewed bytes, and returned
approve with no P0, P1 or P2 finding; its two P3 residuals are closed in
section 12.
| Round | Reviewer | Verdict | Outcome |
|-------|----------|---------|---------|
| 1 | `glm-5.3-flash` | changes requested | The deferral gate alone was insufficient: the transport could still drop a notification on a stream that ended mid-send. Led to the stale-discard path. |
| 2 | `glm-5.3-flash` | changes requested | The delivery state was still session-scoped rather than surface-scoped, so a success recorded against a departed stream suppressed the next one. Led to the re-arm and the surface owner. |
| 3 | `deepseek-v4-flash` | changes requested | The re-arm was unconditional, so a rejected duplicate GET (the SDK answers 409) could tear down a live surface. Led to the surface-ownership rule. |
| 4 | `glm-5.3-flash` | approve with 1 P2, 1 P3 | The successor-stream transition race (a stale send resolving after its surface ended) and a double generation bump on a repeated clear. Both closed by the follow-up pulse, the retry-budget rollback and the idempotent clear. |
| 5 | `deepseek-v4-flash` | approve with 1 P2, 2 P3 | The abandoned pending stream read in the test helper could surface as an unhandled rejection, and two follow-up pulses could fire when both channels went stale. Both closed: the abandoned read is now consumed, and there is one follow-up per pulse invocation. |
| 6 | `glm-5.3-flash` | approve, 3 P3 | The Hermes runtime-root assertions were source-regex matches rather than behavioral tests; the adapter launcher stderr was bounded but not scrubbed; and a late teardown could re-arm a successor surface. All three closed: the resolver moved to `scripts/lib/hermes-python-runtime.mjs` with a behavioral test, the stderr passes through `scripts/lib/adapter-diagnostics.mjs`, and the clear is fenced to the generation that owned the surface. |
| 7 | `glm-5.3-flash` | approve, 2 P2, 2 P3 | The runtime-probe failure message still carried raw child stderr into the scheduled-job receipt (closed in section 4), and the upgraded manifest check still proved execution by mention, so a comment or a self-referencing log line would have counted (closed in section 7). Its two P3 findings were accepted as nits at the time and left open in that round; both were closed in later rounds - the shape-recovery scan accepting any boolean host:port map (closed in section 9) and the backoff-timestamp rollback comparison (closed in section 10). |
| 8 | `glm-5.3-flash` | approve, 1 P2, 3 P3 | The script-name array rule still counted an array that a runner only logs or iterates without executing, so the chain could widen without a suite ever running (closed in section 8); a helper whose name merely sounded like a spawn was accepted as a spawn (closed in section 8); the ingress attribution change carried cosmetic whitespace churn (removed); the source-pattern assertions in the Hermes adapter test were noted and kept, because that file uses that style and the behavioural coverage lives in `src/adapter-diagnostics.test.mjs`. |
| 9 | `glm-5.3-flash` | changes requested, 7 findings (1 P1, 3 P2, 3 P3) | The clauses below are the outcomes of those findings, not one clause per finding, and the round's own itemized report is not kept in the repository, so the clauses cannot be checked one-for-one against the tally. The check counted a suite path quoted inside a log message as executed (closed in section 9); it counted a path carried as data — an environment value — as executed (closed in section 9); the call graph ignored a spawn helper that lives in an imported local module (closed in section 9); the ingress exposure recovery accepted any boolean HostPort map and so guessed (closed in section 9); the documentation described a per-route rule while the code is per-profile (aligned in section 9); the unspawnable-runner case did not isolate the import rule (closed in section 9). |
| 10 | `glm-5.3-flash` | changes requested | The check never stripped shell comments from a package.json script body, so a suite named behind a `#` counted as executed (closed in section 10); every token after the interpreter was an executable position, so a flag value that named a suite counted (closed in section 10); an incomplete exposure attribution fell through to the mismatch branch and reported a positive MISMATCH derived from a dropped signal (closed in section 10); an unreadable HostPort key was skipped instead of refused, so shape drift still read as private (closed in section 10); the Hermes adapter carried undeclared, untested `context_transfer` hunks that relaxed a fail-closed continuation gate (reverted in section 10); the dead `firstBoolean()` helper was removed and the uncovered backoff-timestamp restore was asserted (closed in section 10). |
| 11 | `glm-5.3-flash` | approve, 2 P3 | The manifest guard matched only a double-quoted, single-line import, so four import forms that would ship an undeclared sibling module went unseen (closed in section 11); an interpreter flag outside the hardcoded value-flag set was guessed rather than refused (closed in section 11); the source-pattern assertions in the Hermes adapter test were noted and kept, because that file uses that style and the behavioural coverage lives in `src/adapter-diagnostics.test.mjs`. |
| 12 | `glm-5.3-flash` | approve, 1 P3 | The two round-11 findings are confirmed closed with the reviewer's own fixtures: the package-manifest scanner finds a single-quoted, multi-line, side-effect, dynamic-with-options and export-from import of an undeclared sibling module, and ignores a commented-out import and a path that is only data; the interpreter-flag rule refuses an unclassified flag, keeps a classified flag value off the program, leaves the program in place after a boolean flag, and treats a python module flag as naming the program (all closed in section 11). The one P3 is the direction the module flag takes - a suite reachable only through one is reported as unexecuted rather than credited - which fails closed and is now stated in the contract. |
| 13 | `glm-5.3-flash` | approve, 2 P3 | At that point the change was reviewed as the committed state rather than as a working tree: the five commits contain exactly the 34 reviewed files, each commit holds only files that belong to its subject, the two intermediate `package.json` blobs parse, and the checks were re-run against a reconstruction of the committed tree (closed in section 12). The two P3 findings are documentation residuals: the round-7 row still claimed its two P3 findings were unaddressed, and the Workspace App artifact prerequisite of the server-starting suites was not recorded (closed in section 12). |


The mutation table in section 1 is the executable form of these reviews: each
mutation removes one protection and is killed by a named assertion.

---

## Verification evidence

Executed in this pass (all from the repository root):

- `npm run typecheck` — clean.
- `npx tsc -p tsconfig.json --noEmit` — clean.
- `npx tsx src/mcp-tool-catalog-http.test.ts` — passes with the fix; fails
  again with the gate removed (verified by temporarily reverting it).
- the same suite run directly in a bare tree — fails at startup with the
  resolver's own "No built Workspace App artifact found" error, and passes
  when `KONTROL_WORKSPACE_APP_HTML_PATH` points at a built artifact; the
  canonical chain supplies that artifact (section 12).
- `npm run test:manifest` — `EXIT=0`: **198 test files all executed by the
  canonical chain** (14 scripts, 26 runners). Run against the committed
  `HEAD` tree, the same check names the 13 suites that were reachable but
  never executed.
- `node scripts/test-manifest.mjs` — mutation-killable: removing one suite
  from `test:unit` makes the check name that suite and exit 1.
- `node src/test-manifest.test.mjs` — the execution rule is
  regression-tested against fixture trees: a commented-out suite, a
  self-referencing suite and an unwired suite each fail the check; a suite a
  spawned runner executes passes; and a script array that is only logged,
  only printed, or owned by a runner that cannot spawn does **not** widen the
  chain, while one the runner really spawns — directly or through a local
  helper — does. A spawn call quoted inside a log message and a suite
  path carried in an environment value are data, not executions, so both
  leave their suite an orphan; a spawn helper imported from a local module
  and a namespace import of `node:child_process` are real executions, so both widen the
  closure.
- The shell-comment and executable-position rules (section 10) are
  regression-tested the same way: a suite named behind a `#` in a script
  body, a suite named on a comment line, a suite named by a commented-out
  `npm run`, a suite named as a flag value (`node --config src/x.test.mjs`),
  a suite named as an argument after the program, and a suite named inside
  an inline program (`node -e`) each fail the check, while a `#` inside a
  quoted string and a `#` inside a word are literal text and do not comment
  out the rest of the line.
- The package-manifest check (section 11) is checked against itself: the
  import scanner asserts its own behavior against sixteen fixtures, so every
  import form it must find and every near-miss it must not report is named.
  The old guard and the new one were run against the same six fixture
  packages: the old one passed four that ship an undeclared sibling module
  (a single-quoted import, a multi-line import, a side-effect import and a
  dynamic import with an options argument) and the new one fails all four,
  while both fail the two cases the old one already caught.
- The interpreter-flag rule (section 11) is mutation-killable: four
  mutations are each killed by a named assertion - the unclassified-flag
  branch removed, the module-flag branch removed, the unclassified-flag
  report removed, and the boolean-flag set emptied.
- `npx tsx src/ingress/tailscale-status.test.ts` — the drift cases pass: a renamed
  exposure field whose name still identifies it is recovered; a boolean map
  under any other name leaves the exposure unproven instead of being read
  as public exposure; a renamed field whose shape cannot be read leaves the
  exposure unproven; contradictory documents leave it unproven; and a
  HostPort key that is not recognizable refuses the whole map instead of
  silently dropping the route it names.
- `npx tsx src/ingress/profile-status.test.ts` - the classification under an
  unproven attribution is `UNKNOWN` in both directions: a route that differs
  from the configured profile is not reported as `MISMATCH` when its exposure
  could not be read, and it is still reported as `MISMATCH` when the
  attribution is complete. Verified directly against the classifier, for
  both the serve and the funnel kind: complete -> `MISMATCH`, unproven ->
  `UNKNOWN`.
- `npm run test:syntax` — `EXIT=0`.
- `npm run test:package` — `EXIT=0`.
- `npx tsx src/server/catalog-refresh.test.ts` - the stale-delivery path is
  asserted directly: a send that resolves after its delivery surface ended
  is discarded, does not consume the retry budget, and does not leave a
  backoff timestamp that the next delivery surface would have to wait out.
- `npm test` - the full canonical chain, run in an isolated tree that holds
  `HEAD` plus exactly this 34-file change (no other working-tree edit is
  present in it), so the result is not contaminated by concurrent work in
  the shared checkout. `EXIT=0` on every run. The final run is against an
  isolated tree whose tracked files are exactly the committed state:
  `.tmp-scratch/test-npm-test-r15.log`. The two earlier runs are
  `.tmp-scratch/test-npm-test-r13.log` and
  `.tmp-scratch/test-npm-test-r14.log`. The logs are local artifacts, not
  committed.
- `node --import tsx scripts/scheduled-readonly-adapters-e2e.mjs` — CRUSH and
  Hermes both dispatched and stayed confined.
- `KONTROL_CADDY_BIN=/tmp/caddy npm run qualify:ingress` — 12 pass,
  6 `source_verified`, 0 unverified, 0 failed, 6 blockers (items A–C).

### Changed and added files

One row per file. These are exactly the files the change touches, and
they are the same 34 files that `git diff --name-only 44c247a..HEAD` names.

| File | Change |
|------|--------|
| `src/server/mcp-http.ts` | pulse deferral gate, delivery-surface ownership, re-arm, generation-fenced clear, single follow-up pulse |
| `src/server/catalog-refresh.ts` | `stale` delivery outcome, the retry-budget rollback, and the narrowed backoff-timestamp restore |
| `src/server/mcp-session-state.ts` | `deferredNoStreamAttempts`, `staleDeliveries`, `deliveryGeneration`, `standaloneSseEstablished` |
| `src/server/diagnostics.ts` | projection of the two new counters |
| `src/mcp-tool-catalog-http.test.ts` | end-to-end delivery, re-arm and re-delivery assertions |
| `src/server/catalog-refresh.test.ts` | unit test for the stale path, the budget rollback, and the backoff-timestamp restore |
| `scripts/acp-hermes-native-adapter.mjs` | `PYTHONHOME` for a relocated interpreter, scrubbed launcher stderr, and a stable probe-failure category for both the launcher and the runtime probe. The undeclared `context_transfer` hunks that rode in with it were reverted (section 10) |
| `scripts/lib/hermes-python-runtime.mjs` | **new** — the shared interpreter runtime-root resolver |
| `scripts/lib/adapter-diagnostics.mjs` | **new** — the adapter log scrubber, plus the stable probe-failure category and the scrubbed probe detail |
| `scripts/lib/read-only-execution.mjs` | conditional read-only `/etc/resolv.conf` bind |
| `src/hermes-native-adapter.test.mjs` | runtime-root and `PYTHONHOME` contract assertions, and the assertion that neither probe message carries stderr or a raw detail |
| `src/hermes-python-runtime.test.mjs` | **new** — behavioral tests of the runtime-root resolver |
| `src/adapter-diagnostics.test.mjs` | **new** — behavioral tests of the log scrubber and of the probe-failure category |
| `src/read-only-execution.test.mjs` | resolver-bind assertions |
| `src/package-files-manifest.test.mjs` | **new** — every relative import of every shipped script must be a declared package file. The import scan is a scanner, not a pattern: any quote style, any line count, a side-effect import and a dynamic import with an options argument are all found, a commented-out import is not an import, and a path that is only data names no module (section 11) |
| `src/test-manifest.test.mjs` | **new** — regression test for the execution rule: a wired or spawned suite passes, while an unwired, commented-out, self-referencing, logged-array, printed-array, unspawnable-runner, fake-spawn-shape, quoted-call, data-carried, shell-commented, flag-value, or trailing-argument suite each fails. It also covers the interpreter-flag rule: an unclassified flag fails the check and is named, a classified flag value names no program, a boolean flag leaves the program where it is, and a python module flag names the module rather than the path after it (section 11) |
| `src/ingress/tailscale-status.ts` | exposure attribution unioned across both status documents; a renamed field recovered only when its name still identifies it; an unidentifiable boolean map leaves the exposure unproven instead of being guessed; an unreadable one refused; a HostPort key that cannot be normalized refuses the whole map |
| `src/ingress/profile-status.ts` | a route with unproven public exposure is `UNKNOWN`, never `MAPPING_MATCHED` and never a positive `MISMATCH` |
| `src/ingress/tailscale-status.test.ts` | drift cases: renamed field, unreadable field, contradictory documents, an unrelated boolean map, a renamed field with an unreadable shape, and an unrecognizable HostPort key |
| `src/ingress/profile-status.test.ts` | the unproven-exposure classification (including the case where the route also differs), the `FUNNEL-EXPOSED` derivation, and the assertion that a complete attribution still reports a genuine mismatch |
| `src/ingress/controller.test.ts` | fixture updates for the new facts fields |
| `src/ingress/ingress-tools.test.ts` | fixture updates for the new facts fields |
| `src/ingress/qualification.integration.test.ts` | fixture updates for the new facts fields |
| `src/cli.test.ts` | platform-guarded spawn tripwire; the quoted-binary ban covers every quoting form |
| `scripts/test-manifest.mjs` | the manifest check now proves *execution* by the canonical chain, not reachability: only a path that reaches a process as the program or as an argument-vector element counts, a call quoted in a string literal is not a call, a spawn helper in an imported local module is followed, shell comments in a script body are stripped, and only the first positional argument of an interpreter is the program it runs. An interpreter flag the checker cannot classify fails the check instead of being guessed (section 11) |
| `scripts/test-manifest-allowlist.json` | the four stale exclusions removed; the allowlist is empty and a stale entry is now a failure |
| `scripts/run-ui-tests.mjs` | the UI runner also executes the connection-lifecycle suite |
| `src/bridge/handoff-tools.ts` | the one-time activation tools' lack of a mutation receipt is now documented (the grant is the idempotency fence) |
| `src/ui/review-thread-delivery.ts` | the delivery-loop default is documented as a host-boundary guard, not a redundant coalescing |
| `package.json` | three new declared package files (one of them a pre-existing gap); thirteen suites that were reachable but never executed are now wired into the canonical chain, together with the three new suites this pass added |
| `AGENTS.md` | the catalog-notification, sandbox and ingress-attribution contracts, updated to match the code, and the canonical-chain rule stated as an executable position, including that a shell comment is not a command, that an unclassified interpreter flag fails the check, and that the package-manifest check is a scanner rather than a pattern |
| `docs/ingress.md` | the public origin mode decision and the exposure-attribution rule |
| `handoff.md` | this record |
| `HANDOFF.md` | the earlier scheduled-job audit record, updated with the deployment status this pass verified |

### Suites this change newly executes

None of these suites is modified by this change; their contents are
unchanged. What changed is that the canonical chain now executes them,
so a failure in one of them now fails the chain. The list is the same
13-suite list as the table in section 6.

| Suite | Now executed by |
|-------|-----------------|
| `src/review-thread/review-thread.test.ts` | `test:unit` |
| `src/review-thread/review-thread-mcp.test.ts` | `test:unit` |
| `src/ui/review-thread-delivery.test.ts` | `test:unit` |
| `src/review-browser/contracts.test.ts` | `test:unit` |
| `src/mcp-inspection-output.test.ts` | `test:unit` |
| `src/pi-tools-read-snapshot.test.ts` | `test:unit` |
| `src/qualification/external-catalog-capture.test.ts` | `test:unit` |
| `src/scheduling/scheduled-artifact-publisher.test.ts` | `test:unit` |
| `src/server/mcp-qualification-evidence.test.ts` | `test:unit` |
| `src/workspace-app-resource-registry.test.mjs` | `test:unit` |
| `src/ui/connection-lifecycle.bootstrap.test.ts` | `test:ui, through scripts/run-ui-tests.mjs` |
| `scripts/probe-mcp-tunnel-failure.test.mjs` | `test:syntax` |
| `scripts/lib/probe-failure-receipt.test.mjs` | `test:syntax` |

## Environment notes

- A static Caddy binary is at `/tmp/caddy` (not in the repository).
  `KONTROL_CADDY_BIN` selects it; without it the matrix leaves the Caddy
  scenario `unverified` (never `pass`). The generated report
  `ingress-qualification-matrix.json` is a local artifact and is not
  committed.
- The live deployment still runs the older immutable artifact
  `releases/f1552d7fc7f87e10`; this pass changed source only. Deploy the
  new candidate through the normal `./restart-kontrol.sh` prepare/activate
  path.
- `tailscale serve` does not fail fast in the disabled state; the
  controller classifies the failure (`serve_not_enabled`,
  `command_timed_out`) instead of reporting an opaque exit code.
- This host's tailnet has Serve disabled (item A).
- Another session is editing the same checkout concurrently. Its edits
  are not part of this change and are not staged by it: every commit in
  this pass contains only the files this change owns, and the
  verification run was executed against an isolated tree that holds
  `HEAD` plus exactly this change.
- A suite that starts the server needs a built Workspace App artifact. In a
  checkout without `dist/ui/workspace-app.html` it fails at startup with
  "No built Workspace App artifact found"; run `npm run build:app` first, or
  point `KONTROL_WORKSPACE_APP_HTML_PATH` at a built artifact. The canonical
  chain needs no preparation, because `scripts/run-runtime-tests.mjs` builds
  the app into a temporary artifact directory and points the variable at it.
