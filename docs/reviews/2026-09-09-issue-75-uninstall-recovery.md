# Issue #75: uninstall recovery guard

Scope: fixed base `166426d5a7269ffe4b5dd1f3270451aa2fe20c0c`, isolated
`fix/issue-75-uninstall-recovery` branch. The issue and its empty comment thread
were read directly through `gh issue view 75 --repo b-relay/rig --json
number,title,body,comments`; the supervisor retained its issue JSON backup.

## Contract and implementation

The daemon administrator asks `runtime.command({ action: "prepare-uninstall" })`
for permission to remove daemon control. Any Target recovery record now rejects
with `DEPLOY_RECOVERY` and explicit `rig down` guidance before observing candidate
components or setting draining. This includes pending, blocked, and committing
recovery, irrespective of current candidate component state. A rejected request
preserves Target plans and recovery, and subsequent down can complete recovery.
The existing administrator propagates this failure before stopping the daemon or
removing installation/token files. No new interface or provider is needed.

### Function-design ledger: runtime execute / prepare-uninstall branch

| Field | Contract |
| --- | --- |
| Inputs | RuntimeCommand; closure-owned draining/queue; caller-supplied RuntimeDependencies, including store, ownership, observations, ID, clock, diagnostic writer. |
| Outputs | `{ ready: true }` and draining on successful readiness; structured RigError on recovery or unsafe running state; failure activity and diagnostics through existing record owner. No Target mutation on rejection. |
| Ambient access | Store/ownership/observation and diagnostic providers own external access and are passed to createRuntime. Queue and draining are runtime-owned receiver state. No new ambient dependency. |
| Prerequisites | Mutations serialize through command's queue; ownership must be ready before reading inventory; validate recovery and running state before draining. |
| Failure | Recovery uses existing DEPLOY_RECOVERY distinction and down guidance. Existing catch records the failed attempt, then propagates; logging failure does not replace the original error. |
| Callees | assertOwnershipReady reads provider ownership evidence (existing tested boundary); store.read reads inventory; Array.some reads supplied Targets; RigError constructs tagged data; observeTargets reads supplied provider observations (existing tests); record uses store.update, now and diagnostic for failure evidence. These existing dependencies are tested or documented and remain unchanged. |

Steps 1–3: the command and its supplied providers remain the effect owner; the
public call and dependency contract are unchanged. Step 4: a local predicate
needs only presence of a Target's recovery field, with no stage-specific policy.
Step 5: refusal must remain distinct from success and must leave mutations
available. Step 6: recovery validation is a peer readiness condition before
observation and draining. Step 7: uninstall safety stays owned by the serialized
runtime command; administration consumes the existing result/error contract.
Step 8: tests cover all recovery stages, preserved records, down after rejection,
and readiness after down. The real direct caller is DaemonAdmin.performUninstall,
which awaits readiness before its stop/removal effects. It needs no code change.

Test callbacks own their isolated fixture/file/process effects. Runtime test
inputs are fixture-owned stopped candidate and prior managed plan; outputs are
public command results/errors and caller-owned store state. Admin test inputs
are a temporary root and loopback test daemon; outputs are admin status/errors,
installation/token file contents and successful removal after readiness clears.
The test daemon supplies a controlled protocol rejection; the runtime test
establishes the actual recovery decision. No test claims a live launchd process
reproduction. Existing empty-inventory success and process uninstall behavior
remain covered; no new streaming, borrowing or cancellation contract is added.

## Validation

- Red: runtime regression failed in all three recovery stages because readiness
  resolved `{ ready: true }` instead of rejecting (12 pass, 3 fail).
- Green: 23 tests passed across `tests/runtime-application.test.ts` and
  `tests/daemon-admin.test.ts` (76 assertions).
- Strict TypeScript: `bun run typecheck` passed.
- The initial sandboxed daemon run could not expose its localhost service and
  failed startup checks. The same tests passed with approved elevated execution,
  using fresh temporary RIG_ROOT and process-mode daemons only.
- Full suite/build and independent review are assigned to the supervisor.
- No live Rig state, launchd labels, Caddy configuration, or deployed worktrees
  were observed or changed. The only production code change is the readiness guard.
