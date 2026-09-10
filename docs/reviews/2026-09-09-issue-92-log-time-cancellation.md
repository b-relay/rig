# Issue #92: Target recording time and follow cancellation

Base: `364fbbd7027d3c12bd5a5277540ce6f8a545fada`.
Scope: buffered Target setup/hook/build output, normal log reader, public follow
consumer, production composition and compiled CLI termination. No runtime
inventory, deployment, storage-schema or retention change.

## Interface choice

Before: `createTargetEffects(options)` acquired `new Date()` inside recording;
`runRigCli(args, dependencies)` accepted an optional wait and silently chose an
ambient timer when omitted. Its catch also turned every error into exit zero if
the signal happened to be aborted.

After: Target adapter options require `recordingTime(): string`, acquired once
for each retained output entry. Daemon composition supplies ISO wall time.
CLI dependencies require `wait(milliseconds, signal): Promise<void>`; CLI main
supplies `waitForLogPoll`, an adapter that owns timer/listener setup and cleanup.
Follow still supplies 250 ms and forwards the invocation signal. Only a tagged
`CANCELLED` error accompanied by an aborted invocation gets cancellation success;
concurrent daemon/reader failures remain failures.

Compared designs:

1. A timestamped command-output DTO from a runner, plus a scheduler-driven stream
   abstraction, could move both responsibilities out of existing owners. It would
   expand the runner contract and duplicate reader/paging policy for this small
   slice. The existing runner buffers stdout/stderr separately and cannot promise
   execution-time interleaving, so such a DTO must not imply it.
2. Two explicit capabilities at the existing effect owners: a recording-time
   acquisition callable consumed by Target output recording and a required wait
   callable consumed by CLI follow. Chosen: it preserves per-entry granularity,
   existing reader ownership and the command contract with two narrow real seams.
   Neither dependency is forwarded through the whole Logs path.

The setup timestamps are recording times after command completion, not claimed
execution times. stdout lines precede stderr lines as before; interior blank
lines remain records, the final empty split fragment is omitted, and empty streams
acquire no timestamps. `target.jsonl`, 0700 new directories and 0600 new files are
unchanged. Existing files retain their permissions through append as before.

## Function contract ledger

| Function / caller | Inputs, result and mutation | Effects, failures and ownership | Direct-callee trust / inherited debt |
|---|---|---|---|
| `createTargetEffects` / `recordOutput` | Supplied recording-time source, command result, Target log destination and component; resolves after append; no caller data mutation | Adapter owns mkdir/append and calls the supplied source per retained line; clock/serialization/filesystem failure propagates; partial filesystem effects remain possible | Node filesystem and JSON behavior trusted; reader round-trip proves storage compatibility. Clock callable must produce valid ISO strings and may throw; production source is explicit. Other existing adapter filesystem/provider effects remain out of scope |
| `runTarget`, hook, prepare and installed build callers | Existing command request, Target and component; same result/failure return behavior | Existing runner buffers output; invokes recording after completion; time dependency is captured by the effect owner, not forwarded through lifecycle | Runner and existing hook/build/prepare tests trusted; no execution-time precision or cross-stream interleaving claim |
| `composeDaemon` | State root and capture command; returns Host options | Composition owns wall-clock source selection for Target recording separately from diagnostics and runtime clocks | Existing provider composition retained; real daemon hook output test exercises production recording source |
| `runRigCli` / execute closure | Arguments, client/output/diagnostics/identity, required wait and optional cancellation; returns exit code | Same command preparation, correlated request, output and diagnostic effects. Cancellation before submission requests no daemon action. Only tagged cancellation can suppress an error; unrelated failure still invokes existing failure reporter | Command parser, interaction, reporting and client interfaces covered by CLI/transport tests. Inherited request transport does not accept this signal, so in-flight requests are not newly abortable; this issue changes waiting, not request timeout policy |
| `followLogs` | Request, initial page, supplied client/output/wait/signal; resolves on cancellation | Waits, requests next opaque cursor page, renders page and replaces local cursor; no caller mutation; does not catch daemon/reader/wait/output failures | Existing reader owns cursor identity, chronological merge, rotation/truncation and invalid-record policy. Successive empty and repeated-text pages tested; no new cursor parsing or lifecycle request |
| `waitForLogPoll` | Delay and optional signal; resolves on elapsed timer or cancellation | Explicit timer owner; already aborted signal schedules nothing. Clears timer and removes listener on normal completion or abort; cancellation is normal completion, not a rejected synthetic failure | Platform timer/AbortSignal contracts trusted and exercised by public CLI cancellation and compiled signal test. No external/caller-owned state mutation |
| `main` | CLI args; exit code | Process entry owns SIGINT/SIGTERM listeners, AbortController and production scheduler selection; finally removes process listeners | Compiled binary through authenticated localhost fixture proves real wiring. Transport and diagnostic behavior unchanged |
| New/extended test fixtures and callbacks | Owned temporary roots, controlled command output/time, cancellation and cursor pages; assertions | Fixtures own files, server, build/CLI children, watchdog timers and cleanup. Only invocation-owned children killed. Hook fake/client errors are deliberately surfaced | Public `hook`, `RuntimeFiles.logs`, `runRigCli`, authenticated control plane, compiled binary and real daemon seams; no production internals mocked |

No collection borrowing or changed allocation/lifetime promises. Test cases for
invalid clock strings are omitted because this is a trusted adapter capability,
not external user input; existing external request/schema validation is unchanged.
The reader's invalid-record and invalid-cursor channels are retained and tested.

## Verification

- Red: supplied timestamp reader test failed with actual ambient timestamps
  instead of four chosen millisecond timestamps. Green after required acquisition.
- Red: daemon failure racing cancellation returned 0 instead of expected 1.
  Green after narrowing suppression to tagged cancellation.
- Target hook -> normal reader -> public follow verifies retained blank line,
  stdout/stderr identity, chosen times, naming, permissions, empty output and no
  duplicate records across an empty follow page.
- CLI verifies successive opaque cursors including an empty page; repeated text
  remains distinct. Cancellation before start, during the real scheduler wait,
  and after a page issues no subsequent poll. Reader truncation and daemon failure
  remain reported failures without reader repair or lifecycle requests.
- Compiled `logs live --project fixture --follow`: real production main/scheduler,
  localhost authenticated control plane, stopped Target reader fixture, SIGTERM,
  exit 0 within 250 ms, exactly two log requests, one retained output occurrence,
  no requests during a further 300 ms observation, unchanged stopped fixture.
- Real-daemon test exercises production hook timestamp wiring alongside managed
  stdout/stderr and verified lifecycle stop. It uses only its isolated Project.
- Focused validation: 58 tests across Target effects, deployment effects, runtime
  Logs, CLI, interaction, transport, real daemon and compiled follow; all passed.
  This run had 376 assertions. After adding production-hook assertions, the two
  real-daemon/compiled tests passed again with 27 assertions. Strict
  `bun run typecheck` and `git diff --check` passed after the final changes.

All command environments use isolated `RIG_ROOT` ending in `.rig`; fixture files,
compiled binaries, localhost servers and processes are run-owned. No live Rig
state, launchd/Caddy or deployment changed. No full-suite or standalone build gate
was run by the implementer; supervisor owns independent review and release gate.
The targeted compiled test necessarily compiles the CLI. Existing capture timing
for managed applications and daemon transport timeouts are unchanged.
