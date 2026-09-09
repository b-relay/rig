# Issue #81: pre-stop hooks for active processes

## Accepted policy and scope

The [user decision](https://github.com/b-relay/rig/issues/81#issuecomment-5607121301)
was read live on September 9. Pre-stop hooks run before stopping relevant active
managed processes, not on every stop request. A Target hook runs once before the
first eligible component; component hooks run only for eligible components.
Definitively stopped observations suppress pre-stop hooks. Unknown observations,
observation exceptions, and pending restarts retain hooks conservatively.

Stop still attempts every managed component in reverse dependency order. The
provider stop result remains the authority for shutdown and post-stop cleanup.
Component post-stop hooks run only after a changed successful stop; Target
post-stop hooks run after any changed stop, including partial shutdown. Hook
failure never prevents another stop attempt. STOP_INCOMPLETE retains both process
and hook errors; STOP_HOOKS carries verified shutdown and stopped/unchanged outcome.
No restart-versus-deployment STOP_HOOKS policy was redesigned.

## Design and contract ledger

No module/provider interface changed. Existing public TargetLifecycle.down and
runtime.command/reconcile seams were approved for this issue. Observation and hook
providers are explicit injected boundaries. Eligibility belongs in lifecycle.down
so explicit down and automatic reconciliation share the same decision.

Function: createTargetLifecycle(...).down(target), full path.

| Field | Contract |
| --- | --- |
| Caller job/call | Explicit stop, reconciliation, retirement and transitions call lifecycle.down(recordedTarget) to stop its managed processes and receive a final outcome or structured failure. |
| Inputs | Recorded Target plan; injected TargetEffects, Supervisor.observe/stop and hook provider. |
| Outputs | Materialized stopped/unchanged result; process stops; hook effects; STOP_INCOMPLETE or STOP_HOOKS tagged RigError with separate evidence. |
| Ambient access | None added directly; supplied supervisor/hook adapters own process inspection, process mutation and hook execution. |
| Prerequisites | Valid default provider profile, recorded dependency order, runtime operation serialization. Observations are evidence at a point in time, not a shutdown guarantee. |
| Failure | Failed/unknown observation retains pre-stop eligibility; final stop result verifies shutdown. Hooks remain best-effort. Process errors take precedence while retaining hook errors. |
| Callees | assertProviderProfile reads record and rejects unsupported profiles (existing tested boundary); effects.supervisor selects supplied process provider; observe reads provider state; stop mutates/verifies it; effects.hook executes supplied commands. Provider contracts and lifecycle/deployment tests establish these boundaries. Existing local attempt helper collects failures without interrupting remaining work. |
| Conceptual steps | Observe eligibility, run Target/component pre-stop hooks, attempt stop, run existing post-stop cleanup, classify aggregate outcome. |
| Shared policy | Eligibility is owned once in lifecycle.down; direct runtime reconciliation and stop callers inherit it unchanged. |

Observation failures are deliberately not classified as failed shutdown when the
subsequent provider stop verifies success. Unknown state never suppresses hooks.
The borrowed Target record is read, not mutated. Empty plans have no process work;
unsupported provider profile rejection remains covered by deployment-effects.
The stop API's existing blocking behavior and races between observation and stop
are unchanged; this patch adds no timeout or process identity redesign.

Test helper stopHookFixture is an in-memory external-effect boundary: its supplied
active keys and controllable observation/error maps determine results; returned
sets/arrays expose process state and exact command effects, with no Host I/O.
The pure targetWithStopHooks helper returns an owned clone with literal fixture
commands. No caller-owned production state or ambient runtime state is changed.

## Red/green and validation

1. Added one public down regression with all processes stopped and a failing
   Target pre-stop hook. Before implementation: 4 pass / 1 fail, correctly
   reproducing STOP_HOOKS with outcome unchanged.
2. Added the minimal observation gate. Same file: 5 pass / 0 fail.
3. Extended accepted cases: mixed components; repeated down; unknown, failed and
   restart-pending observations; exact successful/failed-stop and hook outcomes;
   empty managed plan; fresh runtime reconciliation of both stopped and active
   processes under stopped intent. Kept external hook counts as explicit contract
   evidence requested by the issue.
4. Installed lockfile dependencies in the isolated worktree. Fixed the integration
   fixture's component union assignment and restricted its diagnostic assertion
   to reconciliation events (commands emit normal successful diagnostics).
5. Final focused validation with RIG_ROOT=/tmp/rig-issue-81-validation/.rig:
   `bun test tests/runtime-lifecycle.test.ts tests/runtime-application.test.ts tests/deployment-effects.test.ts`
   — 54 pass, 0 fail, 230 assertions. `bun run typecheck` — passed.

No real Rig state, launchd service, Caddy configuration, or deployment remote was
mutated. Full suite, build, independent reviews and merge are supervisor gates,
not claimed by this implementation handoff. PRD, schema help and rewrite plan
were synchronized with this policy.
