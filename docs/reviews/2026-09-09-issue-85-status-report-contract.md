# Issue 85: Project Status report contract

Base: `93b5b636f560216520f51b501ab8fa9273c44000`. Scope: Project Status only.
Live issue and comments read on September 9 (no comments). No live Host state,
launchd service, Caddy configuration, or deployment was changed.

## Designs compared before implementation

1. Keep a single `command` API and introduce overloads or a conditional result map.
   This keeps one method but forces dynamic dispatch and test clients to carry
   command/result correlation, or retains casts at the point where callers need
   the report. Extending the map to all commands is outside this slice.
2. Add one typed `status(selection)` read capability beside the existing command
   capability, with a shared domain schema and inferred report types. Both the
   runtime and network adapter implement this capability. The existing wire action
   and generic `command({action: "status"})` remain compatible.

Selected design 2. It makes the human presenter and picker consume
`ProjectStatusReport` without introducing an all-command dispatcher framework.
The localhost adapter owns external validation; runtime construction is checked
by TypeScript against the same report types. In-memory clients promise the typed
report directly, rather than implementing a second partial validator.

## Before and after

Before: runtime constructs Target/component reports, then erases them to unknown;
HTTP validates only an envelope; human output coerces missing shapes to empty;
the picker independently validates only Target name/kind/state.

After: the domain schema owns field and state meaning. `DaemonClient.status`
validates the envelope, complete nested report and explicit Project identity.
Missing/malformed reports fail with the existing safe `DAEMON_PROTOCOL` error.
The CLI uses the typed read capability and `renderStatus`; the picker uses that
same capability. Generic non-Status response handling, auth, origins, request
schema, HTTP routes and timeout policy are unchanged.

`warnings` and all previously optional observation/source fields remain optional.
Unknown extension fields pass through at Project, Target and component levels.
No defaults invent Targets, states or warnings, and parsing does not normalize
source/evidence strings. A valid empty report still prints the existing empty
message and the picker reports that no Targets are available. Configured-only
capabilities, recorded source/routes, failed/starting/stopped/unknown observations
and unresolved recovery keep their existing runtime meaning.

Human fields retain the existing output sanitizer (controls become spaces).
Picker labels use the existing terminal sanitizer (controls removed); selection
values and structured output retain their original data. Those two display
policies predate this work and are intentionally not a string normalization policy
for the domain model.

## Function-design ledger

| Function / callers | Inputs, outputs, ownership and effects | Failure and direct-callee trust |
| --- | --- | --- |
| `DaemonClient.status`; called by CLI entry adapter, command compatibility path, and external readers | Selection plus receiver address; owned parsed report; HTTP/auth and timeout remain in network effect owner; no caller mutation | `request` reads network and is covered by real localhost/auth/envelope tests; Zod `safeParse` is trusted validation; protocolFailure constructs safe tagged error; malformed nested fields and explicit identity mismatch have one owner |
| `DaemonClient.command` | Existing command/address; same unknown results for non-Status, delegates Status to typed capability | Existing request and envelope behavior retained; Status failures now propagate before presentation |
| Runtime `status` closure; called by runtime command and in-memory consumers | Explicit selection, captured runtime dependencies; registered Project and recorded inventory read; complete typed report; no inventory mutation | `selectProject` reads store/documents and validates registration/path (existing runtime regression coverage); store reads may fail; `projectStatus` tested through runtime and transport; read failures propagate as before |
| `projectStatus` / `configuredComponents` | Project name/path, readonly records, Status selection, ownership/observation effects and document read capability only; owns fresh report assembly and warnings | `targetName` validated selection policy, `asRigError` safe error mapping, `observeTargets` provider/deadline behavior, documents.read and assertOwnershipReady effects: all covered by existing runtime tests plus roundtrip; config/ownership failure remains warning/unknown; recovery overrides remain unchanged |
| `observeTargets` / `aggregate` | Readonly recorded Targets, observation effects, budget/deadline; report types now use shared state vocabulary; aggregate remains pure | Existing bounded-observation tests establish completed/rejected/expired and mixed capability behavior; no new provider or timing policy |
| `targetName` | Only target/deployment/branch fields now required; pure name/hash result, no caller mutation | Existing crypto hash trusted deterministic algorithm; reserved/missing Preview selection errors unchanged; lifecycle/deployment callers retain behavior |
| `renderStatus` / `displayWord` | Typed borrowed report / optional string; pure text result, no mutation, I/O or validation | Array/string operations trusted; typed optional handling is presentation only; terminal fixture and runtime roundtrip cover ordinary, empty, unknown, failures, warnings and control characters |
| `prepareInteractiveRequest` | Request and only signal/interaction/client/output capabilities; returns selection; interaction and optional output effects remain explicit | status reader contract is trusted; abort and empty/no-selection errors preserved; other context schemas/readReply unchanged; tests cover choice, cancellation and noninteractive failure |
| `runRigCli` execute callback | Request, dependencies and scoped output mode; acquires typed Status once; writes human or JSON and diagnostics | status reader, renderStatus and existing command path covered by CLI/transport tests; rejection uses existing failure owner, never reaches healthy/empty presenter |
| CLI `main` status adapter | Captured isolated or configured root; reads daemon address/token, then network status | Same address/token adapters and DAEMON_MISSING policy as command; real daemon test verifies composition and cleanup; no offline-doctor behavior change |

Pure helpers have no rejection/partial-progress channel beyond optional display
text. Arrays are materialized, no borrowed result is retained, and no new
callback/lifetime/locking mechanism was introduced. Real callers were reread
following the change. Test fixtures now implement the typed capability explicitly.

Inherited debt: non-Status command results still use unknown and permissive
presenters, deliberately outside scope. `selectProject` still accepts broad
runtime dependencies despite reading only store/documents; its existing path
resolution behavior was not rewritten. Runtime observation adapters and their
bounded scheduler keep their documented environmental effects. The entry adapter
retains repeated address-missing handling because doctor has an existing offline
fallback; no generic connection/dispatch redesign was added.

## Evidence

- Red: `RIG_ROOT=/tmp/rig-85-red/.rig bun test tests/transport.test.ts`:
  2 pass / 1 expected failure: malformed `{result:{}}` resolved instead of
  rejecting with `DAEMON_PROTOCOL`.
- Green after smallest boundary change: same public transport tests 3 pass.
- Initial typed-consumer gate: 55 tests / 293 assertions passed across CLI,
  interaction, runtime Status and runtime application tests.
- Extended runtime/localhost/picker gate: 31 tests / 163 assertions passed.
- Real daemon and administration gate passed all 9 process/daemon tests. The
  combined 70-test run found one test expectation mismatch: existing picker
  sanitizer removes newline rather than replacing it with a space. Corrected
  the expectation to preserve existing terminal-adapter semantics; focused
  transport rerun passed 5 tests / 40 assertions.
- Strict TypeScript checking passed after typed capability migration and after
  extended transport tests.

Final focused results and compiled entrypoint checks are recorded below. Full
suite, independent review and merge are reserved for the parent supervisor gate.

Final verification:

- `bun run typecheck`: passed after all helper/caller changes.
- Affected six-file gate: 65 passed and one new test failed solely because it
  compared JSON property order. The corrected structural-equality transport
  rerun passed all 6 tests / 50 assertions. The other 60 affected tests were
  already green; no production changes followed that gate.
- The 9 real process/daemon tests passed in the earlier focused gate.
- `bun run build`: all three binaries compiled successfully (already launched
  before the parent reserved subsequent build/entrypoint gates).
- `git diff --check`: passed. Full suite and independent review remain parent
  gates. No installed OS launchd/Caddy behavior was exercised.

## Parent full-gate follow-up: migration fixture timestamp race

The parent gate at `15dd775` passed 268 tests and failed only migration-runtime-e2e
with `LEGACY_ADOPTION_INVALID` at adoption.ts:227. Both independent PR review
comments at that head were read and reported clean Standards/Spec findings.

Using the diagnosing-bugs loop, the original isolated migration test first passed
(1 test / 13 assertions). Ranked hypotheses were: an observation timestamp later
than final verification, mismatched process identity, or changed migration source.
The first hypothesis predicts exact rejection when construction crosses a clock
millisecond. Git comparison confirmed neither the adoption validator nor this
fixture had changed in the Status PR.

A temporary 3 ms delay immediately after capturing `verifiedAt` reproduced the
same line-227 failure: verifiedAt was `20:42:20.240Z`; the next observation could
only occur at or after `20:42:20.246Z`. JavaScript evaluates that object property
before mapping the process observations. The preservation check correctly rejects
`observedAt > verifiedAt`; the old test happened to pass when all reads shared one
millisecond. Provider identities and preservation policy did not change.

Bounded correction: capture one timestamp for the fixture's synthetic ownership
snapshot and use it for both verifiedAt and observedAt. Production code and all
preservation checks are unchanged. No helper or new runtime contract is added.
The test's existing public finalization, daemon, storage and exact-byte assertions
remain the regression seam.

Verification of the correction:

- Isolated migration-e2e plus migration-adoption: 6 pass, 26 assertions.
- Strict TypeScript checking: passed.
- The same forced clock gap now passes: snapshot `20:43:17.900Z`, construction
  resumed `20:43:17.906Z`, 1 pass / 13 assertions.
- Temporary clock-delay/debug instrumentation was removed; final fixture matches
  the version that passed the six-test check. No full-suite rerun was performed.

This is an inherited test-fixture race exposed by the parent gate, not a Status
runtime regression or an environment-only dismissal. Capturing snapshot time once
prevents scheduling and millisecond-boundary timing from changing fixture validity.
