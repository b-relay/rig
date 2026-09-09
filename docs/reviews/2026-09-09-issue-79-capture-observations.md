# Issue #79: application observations behind launchd capture

Scope: bounded correctness fix for GitHub issue #79, read live with its comments
on September 9. Base: `8d116cb9a938074dc1f2427217f425203004115e`.
The accepted seams are provider operations, real capture subprocess execution,
and the public runtime status read model. No live deployment is part of this work.

## Contract and design

A launchctl job PID proves wrapper presence, not application presence. The capture
entrypoint now publishes application observations from its existing 50 ms loop
into an atomic sibling `.observation.json` file. Evidence contains the wrapper
PID and immutable birth identity, the observation acquisition timestamp, the
application birth identity when running, and the existing `ProcessObservation`.
The original `.status.json` startup handshake remains a separate compatibility
contract and is never read as current application state.

Two shapes considered:

- A request/response IPC endpoint in each capture wrapper would acquire child
  state on demand, but adds server lifetime, endpoint ownership, transport errors,
  timeout handling, and shutdown machinery to this bounded fix.
- A bounded-age snapshot from the existing loop reuses its observation ownership
  and preserves the existing Supervisor contract. Chosen because no new scheduler
  or transport is needed. launchd readers verify both process identities afresh.

Snapshots are accepted only when their wrapper PID matches launchctl's current
PID and its current birth identity matches. Running additionally requires a
current matching application birth identity. Acquisition age is checked after
identity inspection; future timestamps or age greater than 1,000 ms are unknown.
Missing, invalid, unreadable, startup-only, stale, or mismatched evidence and
cancelled observations are unknown, never promoted to running or stopped. The
existing two-second public status deadline continues to bound concurrent probes.
Identity inspection uses the existing bounded process identity adapter.

Restart-pending observations remain stopped with `restartPending: true`, so
status renders starting for both checked and unchecked applications. A recovered
application has its own PID, running without a health check and healthy only when
the configured check passes. Terminal child observations retain exit evidence;
a wrapper that has already exited uses launchctl's terminal exit evidence.
Explicit up during observed backoff waits for the existing application recovery
instead of replacing the wrapper and resetting its retry budget.

## Function-design ledgers

All changed functions take the full path because they own external effects or
call providers. No major provider interface change is introduced.

| Function | Caller job / inputs | Outputs and effects | Ambient access and prerequisites | Failure owner and callees |
|---|---|---|---|---|
| `runCapturedProcess` | Private rigd process entrypoint; read request path and supervise its application | Existing startup handshake, new atomic child snapshots, exit code, signals and owned child cleanup | Explicit process entrypoint owns filesystem, wall clock, process PID, signal handlers, and supervisor lifetime; acquisition timestamp precedes child observation; retain app birth identity only for its observed PID | Entrypoint retains existing failure/cleanup policy; `createChildSupervisor` and process identity reader are trusted via real-process tests; snapshot publisher is verified by launchd/status integration |
| `writeCaptureObservation` | Publish the supplied complete evidence at the supplied request path | Atomic file replacement and temporary-file cleanup; rejects I/O errors | Filesystem adapter owns filesystem and temporary UUID effects; caller owns directory and request path | Writer propagates I/O failure to capture entrypoint; fs atomic write/rename operations are trusted platform contracts, exercised through subprocess publication |
| `readCaptureObservation` | Return current application evidence for a known launchd wrapper PID; request supplies path, identity reader, clock, and optional signal | Materialized ProcessObservation, no mutation; file and process reads only | File adapter owns bounded snapshot read; provider and clock effects explicit; launchctl PID must already be acquired by caller | This observation adapter maps unavailable proof to unknown; schema, filesystem and identity contracts tested with evidence fixtures plus real wrapper/application subprocesses |
| launchd `observe` / factory | Inspect the requested job key with configured root/domain/label, runner, identity reader, clock and optional signal | Existing ProcessObservation now reports app PID and restart/terminal distinctions for capture mode; launchctl/process/file reads | Factory captures options; concrete defaults acquired there; service identity remains existing label policy | launchctl absence retains stopped, other inspection errors unknown; direct capture reader is trusted through provider tests; noncapture behavior remains pinned by existing provider test |
| launchd `waitForApplication` | Wait for a known job to supply a running application observation | App PID or existing tagged LAUNCHD_START error, bounded attempt loop | Uses factory's observe provider, existing 30 attempts / 100 ms startup wait mechanics; observation effects and waits belong to launchd adapter | Start policy stays in launchd adapter; no restart/reset effects; integration verifies recovery and identity |
| launchd `ensureRunning` | Preserve existing process or start requested job using caller-owned ManagedProcess | Existing started/unchanged result, now application PID in capture mode; existing launchctl/plist/request effects | Existing filesystem and launchctl effect owner; before observation must establish current ownership before idempotence; backoff keeps wrapper ownership | Existing tagged error channels preserved; pending recovery reuses wait policy; integration proves unchanged wrapper and exhausted retry count through final transition |

All top-level work remains at adapter/entrypoint operation level: acquire process
state, verify its evidence, publish/read it, then choose the existing lifecycle
result. Freshness policy belongs only to the capture observation reader, restart
policy only to the child supervisor, and label policy only to launchd. The writer
mirrors the existing startup handshake's small atomic-file pattern; a general
filesystem refactor is intentionally outside this issue.

Changed direct callers were checked: production composition supplies launchd's
capture command; runtime status already maps `restartPending` to starting and uses
returned app PID; activity already avoids classifying restart-pending as terminal.
The native child supervisor's own capture-backed observations are an inherited,
separate adapter concern and are not changed by this launchd-specific issue.

## Red / green evidence

1. Added real wrapper/application execution behind a fake launchctl boundary and
   asserted public provider PID/state plus public status. Initial red: returned
   wrapper PID (`expect(started.pid).not.toBe(child.pid)` failed).
2. Implemented periodic ownership-bearing observation snapshots and verified
   launchd reads. Green: backoff starting, recovery running/healthy with new app
   PID, and terminal failure after the existing retry budget is exhausted.
3. Extended that scenario to call up during backoff. Red: outcome was started
   instead of unchanged because launchd replaced the wrapper. Minimal fix waits
   on existing recovery. Green: unchanged wrapper identity and terminal transition.
4. Boundary cases cover absent/corrupt/legacy/stale/future observations, wrong
   wrapper PID or birth identity, wrong/missing app identity, absent app, cancelled
   observation, and valid running/restart-pending/terminal/unknown result channels.
   Expected filesystem absence is tested; arbitrary write-permission failures
   retain existing entrypoint cleanup semantics rather than new public behavior.
   Empty/single-element collection cases do not apply to this scalar observation.

Validation uses `RIG_ROOT=/tmp/rig-79-validation.rig`. Initial sandbox execution
could not inspect child process identity; authorized isolated process tests were
run with escalation. No real launchctl bootstrap/bootout, Caddy, live Rig state,
production Git remote, or deployed applications were touched.

Final checks:

- Focused process/capture/launchd/public-status tests: **22 passed**, 76 assertions,
  one real launchd test filtered out. Exact command: `bun test
  tests/providers-launchd-observation.test.ts tests/providers-launchd.test.ts
  tests/providers-capture.test.ts tests/providers-process.test.ts
  tests/runtime-status.test.ts -t '^(?!real launchd)'`.
- `bun run typecheck`: passed.
- `git diff --check`: passed.
- Full suite/build and independent reviews are the supervisor's final gate.
- The existing real launchd test is explicitly excluded from this isolated gate.

## Operational limits

Observations are bounded snapshots, not an atomic view of application and kernel
state. Running claims additionally recheck live birth identity; transitions can
briefly be unknown until the next snapshot. Existing wrappers built before this
change report unknown until deliberately restarted/upgraded; no automatic state
migration or restart is introduced. Snapshot files stay under provider-owned
runtime roots and are overwritten on subsequent captures. Persistent project
storage and historical state are preserved.
