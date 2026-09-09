# Plan: CLI Observability And YAML Configuration

> Source: [current PRD](../docs/PRD.md), [CONTEXT.md](../CONTEXT.md), and the [completed interview](codex://threads/019de162-a710-73b2-b418-e36383393a60).
> Status: ready for implementation; no slices implemented by this document update.
> Date: 2026-09-09.
> Predecessor: [completed CLI/provider cleanup](cli-provider-cleanup.md).

## Delivery Contract

Phase A delivers clean existing commands, default diagnostics, truthful component
status, recorded-policy lifecycle, and YAML-first config with JSON compatibility
(PRD R1–R7). Phase B adds activity after that model is established (R8).

Concrete interview policies: a **two-second total observation budget** with
concurrent checks, and **daily diagnostic rotation with 14-day retention**.
These are not per-component readiness timeouts or Target-log retention rules.

This document update does not implement, deploy, or migrate anything. Use isolated
fixtures during implementation; do not convert this repo's `rig.json` or the
user's Host config merely to demonstrate YAML support.

## Current Code And Proof Gaps

| Area | Starting point | Required change |
|---|---|---|
| Output | `services.ts` combines logger rendering/diagnostics; `cli.ts` and `rigd-cli.ts` duplicate terminal setup. | User output Interface separate from diagnostics, shared terminal Adapter, correct help/result handling. |
| Config | `project-locator.ts`, `project-initializer.ts`, `project-config-loader.ts`, `config-editor.ts`, and `home-config.ts` assume JSON. | One document policy with YAML/JSON Adapters, including registration and editing. |
| Lifecycle | `rigd.ts` consults recorded local/live state for down; up can rebuild from current config. | Preserve materialized Target policy across up/down/restart. |
| Status | Read models describe desired state; process-supervisor Interface exposes mutations without observations. | Read-only provider observations, one deadline, evidence-backed aggregation. |
| Daemon | Admin infers running/reachable from files; default local server returns constant status; CLI composes `RigdLive` locally. | Real ownership and reachability proof before claiming daemon-mediated control. |
| Logs/activity | Journal/receipts exist; capture varies by provider. | Preserve component, stream, time, Operation identity, and final outcomes in their correct channels. |

September 9 baseline: 255 tests pass using an isolated root containing `.rig`;
both binaries build; type-checking reports 145 diagnostics. A root ending in
`/state` caused eight path-expectation failures. Recheck when implementation
starts, make tests assert injected paths, and distinguish inherited type errors
from regressions. Compiling binaries is not a passing type-check.

## Interface Decisions

The following compares materially different shapes before major contracts change.
Selections are implementation recommendations, not extra user requirements.
Names are provisional; preserve the small Interface and its invariants.

### Config Documents

**A: format branches in every consumer.** Adding YAML to each locator, initializer,
editor, and Host store initially looks small, but duplicates filename conflicts,
parsing, source locations, and serialization policy.

**B: a config-document Module with format Adapters — selected.** Callers request
a document at a Project or Host location. The Module owns supported filenames,
ambiguity detection, syntax rules, source path/format, and safe serialization.
Return source identity and parsed data; existing domain Modules validate Project
or Host schema. Keep syntax trees/comment preservation inside the YAML Adapter.
Use this seam for discovery and editing, not only ordinary reads.

Verify any chosen parser against its primary documentation and executable tests
for YAML 1.2, every prohibited construct, and comment/order preservation. Do not
assume a convenience parser rejects duplicate keys or aliases. A general format
registry or configuration framework is unnecessary.

### User Output And Diagnostics

**A: add formatting and verbosity switches to `logger.info/error`.** Commands
would still choose which arbitrary details are safe and user-facing.

**B: domain results with separate output and diagnostic Interfaces — selected.**
Commands produce reports, meaningful progress phases, and final outcomes. A User
output Module owns terminal formatting through terminal/capture Adapters. A
Diagnostic log Module owns safe structured evidence, correlation, rotation,
retention, and file failures. Both CLIs share one environment Adapter.

Keep direct `console.log` and scattered terminal writes prohibited. When the
split is implemented, update AGENTS.md's current all-output-through-logger rule
to describe the accepted Interfaces using the agent-document guidance. This
planning update does not change that instruction or add implementation code.

### Observed Status

**A: probe inside CLI presenters.** This ties timeout and health semantics to
the terminal and duplicates them for future UI consumers.

**B: `rigd` observations over provider Interfaces — selected.** One request
selects a Project and its Target records. `rigd` supplies resolved context and a
single deadline; providers observe their own capabilities. Return timestamps
and explicit unknown/failure distinctions. A pure aggregation Module computes
states before presentation.

Status must never invoke up, restart, materialize, repair, or destructive cleanup.
Persisting observation evidence is permitted; changing desired policy is not.

### Durable Runtime Owner

**A: runtime per CLI invocation, reconstructing control from files.** This cannot
control the current adapter-local process handles from another client and would
require a different ownership model.

**B: a long-lived local `rigd` with authenticated client calls — selected.** This
follows the existing product contract. Reuse runtime/action Modules behind local
transport; keep installation at the daemon-admin seam. Verify installation,
process presence, and authenticated reachability separately. Limit implementation
to this plan's local capabilities; hosted transport, tunnels, UI, and Git push
transport are not prerequisites here.

## Vertical Slices

Use one failing public-behavior test, the smallest passing implementation, then
refactor. Read `docs/effect-v4-help-notes.md` before Effect changes and record
newly verified API facts there. A helper layer alone does not complete a slice.

### 1. Clean Help And One Error Path (R1, R2)

Dependencies: none.

First test: bare `rig` under isolated state prints help without an error and
exits zero. Then exercise a missing Project/Target error.

- Introduce the output/diagnostic seam through these paths in both CLIs.
- Preserve useful help formatting and all subcommands' `--help`/`-h` behavior.
- Usage errors write safe diagnostics while remaining self-contained in the
  terminal, with no diagnostic path.
- Remove normal global `--log-level` from parsing/help in both entrypoints.
- Establish default info-level file evidence without config/environment dumps.

Exit: subprocess help/error checks and isolated diagnostic readback pass. Help
must not create a runtime owner or install/start a daemon.

### 2. YAML Project Init And Config Inspection (R5, R7)

Dependencies: slice 1 for human output.

First test: initialize a temporary repo, inspect it from a nested directory,
and run `rig config`; new `rig.yaml` is registered and validated config/source
path render without editor metadata.

- Introduce the document Module through init, discovery, registration, and read.
- Preserve existing `rig.json`; rerunning init must neither overwrite it nor
  create a competing YAML file.
- Replace normal `rig config read` with `rig config`; update help/parser coverage
  and retain internal control-plane editor capabilities.
- Use readable formatted JSON for the validated view as agreed. Source YAML
  serialization and diagnostic output remain separate responsibilities.
- Reject both filenames, unsupported `.yml`, schema errors, and every forbidden
  YAML construct. A nearer invalid/ambiguous config cannot silently fall through
  to an ancestor or another format.

Exit: new YAML and legacy JSON flows pass through the public CLI. Invalid input
leaves files/registration unchanged; config inspection itself is read-only.

### 3. YAML Host Policy And Safe Existing Writers (R2, R7)

Dependencies: slice 2's shared document policy.

First test: resolve an isolated Host setting from `config.yaml` through doctor
or provider planning, then repeat with equivalent legacy JSON and obtain the
same behavior without a format warning.

- New Host writes create `config.yaml`. Existing JSON remains JSON when an
  already-supported write is explicitly requested; do not create a second file
  as implicit conversion. Reading missing-config defaults creates no file.
- Apply identical ambiguity and restricted-YAML rules to Host and Project.
- Route existing structured writers through format-aware document handling.
  Preserve YAML comments/order or refuse before mutation. Retain editor preview,
  revision checks, validation, backup, and atomic apply behavior.
- Test manually converting JSON to YAML at the same registered repo: discover
  the current supported document there, validate identity, and reject ambiguity
  even if registration retains the old filename. This compatibility behavior
  must not become automatic Project move/rename repair.
- Document manual conversion: back up externally, convert explicitly, leave one
  supported filename, and validate. No command migrates; JSON users need not
  convert. Machine-owned state stays JSON/JSONL.

Exit: both scopes are format-equivalent; safe editing preserves human structure;
unsafe edits preserve original bytes. Persistent storage is untouched.

### 4. One Real Daemon-Owned Lifecycle Operation (R2, R4, R5)

Dependencies: slices 1–3.

First test: install an isolated real daemon, start a temporary app from one CLI
process, stop it from another, and verify process exit and port release before
the second command reports stopped.

- Implement the selected local daemon/client seam with isolated Host paths,
  launchd label/port, localhost binding, and local token authentication.
- Observe installation, running, and authenticated reachability separately. A
  marker/token file alone cannot prove running or reachable.
- Stop constructing a separate runtime owner per CLI invocation. Preserve
  missing-daemon guidance, uninstall refusal with running Targets, and state
  preservation. Add no normal manual serve/start command.
- Carry one Operation ID across CLI/daemon diagnostics and persist final outcomes
  after effects, including failures/no-ops. Acceptance remains transport-only.
- Route this plan's required reads/writes through the client seam. Exercise
  unreachable/unauthorized requests and daemon restart in isolation.

Exit: cross-client process control works; stopping the daemon changes reported
reachability; one Operation is traceable across both files. Resolve #65's ownership
prerequisite here. Fake reachability or changed wording is insufficient proof.

### 5. Preserve Existing Target Policy (R4)

Dependencies: slice 4.

First test: deploy config A, edit current config to B, then up/down/restart the
existing Target. Provider choice, commands, ports, Branch, and Commit remain
from A until explicit redeploy.

- Share recorded Target resolution across lifecycle paths; preserve source
  metadata. Missing Previews require deploy; stop preserves inventory/data.
- Exercise inside-repo and outside-repo `--project` selection. Current-config
  views use the registered repository; runtime actions use recorded policy.
  Missing/conflicting current config cannot redirect an action or substitute
  today's plan. Fail unsafe resolution with concise guidance.
- Preserve the local Working copy model and test a hook reading a repo file
  without a manual workspace symlink (#64).
- Before claiming safe up/recovery, test partially running Targets: starting
  another component must not leave a previously healthy component unavailable
  when a later operation fails (#66). This is not implicit redeploy.

Exit: recorded-policy and real isolated lifecycle regressions pass, including
ref retention (#73), without deleting Persistent storage.

### 6. Fresh Component-Aware Status (R3, R5)

Dependencies: slices 2–5.

First test: one healthy and one dead runtime component render a degraded Target
with truthful component states rather than the old desired-running summary.

- Add observation capabilities behind process, health, installed-tool, and
  dependency Interfaces. Share one total two-second deadline across independent
  concurrent probes. Cancel unfinished work and render unknown results instead
  of waiting through startup readiness timeouts.
- Pin aggregation cases: no health check, healthy/unhealthy, intentional stop,
  partial failure, all-runtime failure, all-timeout unknown, configured-only,
  CLI-only ready, and mixed installed/managed Targets.
- Keep the accepted capability-based failed/degraded distinction. Do not invent
  a new primary-component config field. Unknown evidence alone cannot imply
  failure or health; show incompleteness beside the failure summary.
- Preserve stopped routes and Previews. Render the accepted indented report,
  component-specific words, and quiet failure summary. Omit config drift and
  healthy diagnostic paths.
- Rig is an ordinary Project: use its actual configured/observed component
  kinds, rather than synthesizing a healthy daemon row.

Exit: public CLI and provider tests establish fresh observations, total deadline,
and no lifecycle/repair effects. Reproduce #67's dead-process/stale-status case
without killing a real service. Broader automatic crash-restart policy remains
a separately tracked reliability task unless required by the runtime proof.

### 7. Finish Command Views And Diagnostic Policy (R1, R2, R5)

Dependencies: slices 1–6.

First test: a deploy shows meaningful phases and final result; a provider failure
shows a compact error with matching Operation ID and an existing diagnostic file
containing safe evidence.

- Migrate lifecycle, deploy, init, list, doctor, config, and daemon responses.
  Test domain results at the orchestration seam and text at the terminal seam.
- List shows identity/count/path. Doctor summarizes healthy scopes and expands
  problems/suggestions, including config/deployment and registration drift.
  Continue independent checks when daemon is absent. Passing checks cannot
  carry failure-sounding messages (#71).
- Implement daily rotation and 14-day retention using an injected clock. Test
  rollover, concurrent CLI appends, and cleanup restricted to owned diagnostic
  files. Never apply this policy to Target logs, activity, or Project data.
- Test redaction with tokens, env values, nested errors, configs, arbitrary
  command strings, and Target output. Retain safe metadata/references only.
- Test diagnostic write failure: no false Details path or loss of the original
  command outcome; show a compact notice when evidence could not be recorded.

Exit: PRD command views pass healthy, usage-error, and provider-failure cases.
Rotation/redaction/correlation are tested through the diagnostic Interface,
not only presentation snapshots.

### 8. Chronological Target Logs (R6)

Dependencies: slices 4 and 7.

First test: two components interleave stdout/stderr; recent and follow views
retain component identity and chronological output with `>`/`!` markers.

- Capture timestamps/stream identity as output arrives, not after concatenating
  whole stdout/stderr streams. Use the shared `rigd` log read model.
- Preserve stable ordering for equal timestamps and repeated identical lines
  during follow. Test finite recent mode and cancellation without app shutdown.
- Exercise each supported real process Adapter's capture path. Legacy combined
  logs lacking stream identity stay readable but must not be falsely relabeled.
- Preserve stopped Target reads. Introduce no custom component destinations.

Exit: live/stopped logs work across providers, application output stays out of
diagnostics, and inspection never starts or materializes a Target.

### 9. Activity Presentation (R8, Phase B)

Dependencies: Phase A slices 1–8 complete.

First test: successful, failed, and no-op daemon Operations appear with final
outcomes in `rig activity`; a CLI usage error does not.

- Derive activity from existing journal and final-outcome evidence, reusing
  Operation IDs and the User output Module.
- Cover lifecycle, deploy, registration, daemon administration, and meaningful
  crash events. Never rewrite acceptance-only history into invented success;
  incomplete historical evidence must stay explicit.
- Start with the basic Host activity view. Do not treat speculative `--since`
  or Target-filter examples as required flags or add audit guarantees.

Exit: users can distinguish action history from diagnostics/application output,
without unapproved retention or tamper-evidence promises.

## Traceability And Execution

| Requirement | Completing slices |
|---|---|
| R1 Human responses | 1, 7 |
| R2 Diagnostics/identity | 1, 3, 4, 7 |
| R3 Fresh status | 6 |
| R4 Recorded policy/context | 3, 4, 5 |
| R5 Command views | 2, 4, 6, 7 |
| R6 Target logs | 8 |
| R7 YAML/JSON | 2, 3 |
| R8 Activity | 9, using evidence from 4/7 |

Execute sequentially in the listed order. Keep provider/control-plane contracts
working while replacing callers. Do not expand into hosted transport, Git push
transport, rename/move, deletion, or plugin infrastructure. Runtime prerequisite
proof remains necessary even if an earlier issue was marked complete.

## Validation And Documentation

- Run focused red/green tests, then `bun test`, `bun run build`, and
  `bunx --no-install tsc --noEmit` for shared changes. Record inherited type-check
  debt and add no diagnostics; fix touched contract errors without suppressing
  the checker. Full unrelated type cleanup is not a product requirement here.
- Isolate `RIG_ROOT`, workspaces, logs, Caddy paths, launchd labels, processes,
  and high localhost ports. Clean up only owned fixtures. Actual cross-client
  control and bounded observations supplement in-memory tests.
- Cover both formats, every forbidden YAML feature, ambiguity, same-repo manual
  conversion, safe editing, and no mutation on invalid input. Assert files and
  external effects, not only captured method calls.
- Update README, `docs/rig-guide.md`, readiness docs, and issue references as
  behavior ships. New examples use YAML, with explicit JSON compatibility.
  Preserve the predecessor plan as completed history.
- This document update creates/comments on no issues. When breaking the plan
  into work items, use these vertical slices and link relevant existing bugs;
  documentation does not close those bugs.

No product questions remain from the interview for this increment. Parser
selection, precise Interface signatures, and deterministic edge-case algorithms
are implementation choices to verify. Expert/`rigx` remains intentionally deferred.
