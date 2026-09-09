# Issue 89 — safe registration and Deployment causal evidence

Implementation base: `52f8d4d92ddc02a5608da31cbee9c3569c5594a3`.
Worktree: `/tmp/rig-issue-89`; branch: `refactor/issue-89-safe-causal-evidence`.
Live issue #89 body and comments read September 9. Scope is the existing runtime
command, deployment, registration, diagnostic and public failure seams authorized
by the issue and supervisor handoff. No live runtime or deployment was changed.

## Interface decision

Before: deployment accepted positional `noUp: boolean`; `persistTarget` accepted
all runtime dependencies. Registration and Deployment wrappers discarded causes,
and the operation logger admitted only the outer code.

Two designs were compared: (1) recursively serialize Error causes/details with
redaction, or (2) classify failures at their policy owner and carry two flat,
closed category fields through the existing diagnostic interface. Design 2 is
selected: no traversal, dynamic keys, raw text, command/config/environment values,
or general-purpose error serialization. The vocabulary is `health`, `process`,
`effects`, `storage`, `config`, `rig`, `unexpected`, `non-error`. Specific known
Rig codes classify into domain categories; other Rig codes become `rig`. Arbitrary
Error messages/names/codes never become causal metadata.

After: `activateDeployment(candidate, previous, { activation: "start" | "prepare" }, deps)`
names caller intent; `persistTarget(target, store: Pick<StateStore, "update">)`
receives its actual effect capability. `RigError.causes` carries safe evidence,
`RuntimeDependencies.diagnostic` admits it, and the file adapter independently
checks both fields against the same closed vocabulary. Both activity-success and
activity-persistence-failure diagnostic paths carry the correlated evidence.
The HTTP error envelope stays unchanged; the daemon log is the causal evidence
owner and remains correlated with the CLI through Operation ID.

Wrapped outer codes and hints are unchanged. Successful recovery rethrows the
original initiating value. When secondary persistence or initial rollback itself
fails, its existing public failure is normalized using `asRigError`, retaining
its public code/message/hint, and adds primary/recovery categories. Raw non-Error
values become the same `UNEXPECTED` public failure as before. This normalization
avoids ambient side tables and mutation of provider-owned errors. Raw generic
error text is no longer retained in `asRigError.details`.

## Function contracts and ownership ledger

| Function / direct caller | Inputs, result, mutation | Effects, failure policy, ordering and callee trust |
| --- | --- | --- |
| `failureCategory` | Borrowed unknown value to one category; no mutation or retention | No I/O or ambient acquisition. Bounded instanceof/code checks; malformed prototype/code access is caught. Trusted category table, ConfigError and RigError contracts; no cause/detail traversal. |
| `failureCauses` | Primary unknown and optional secondary unknown to owned flat evidence | Pure total classification. Explicitly thrown undefined is distinct from no secondary argument. `failureCategory` is covered by malformed/cyclic/secret tests. |
| `diagnosticCauses` | Unknown failure to fresh allowlisted evidence | Reads only bounded fields from RigError; catches malformed getters. Uses trusted category membership and classifier. Never forwards arbitrary nested cause objects. |
| `RigError` / `asRigError` / `retainFailureCauses` | Safe existing public failure contract plus separately classified causes; creates a new error for secondary failures, no mutation of borrowed provider errors | Normalization owns public failure conversion; no I/O. Generic failures use unchanged UNEXPECTED guidance; malformed prototype inspection falls back safely. Known ConfigError conversion remains compatible. Provider-defined RigError message/hint validity remains inherited trust. |
| `registerProject` | Command plus existing document/store/id/clock capabilities to ProjectRecord | Existing document initialization precedes registration transaction; failed transaction preserves initialized files and REGISTRATION_INCOMPLETE hint. Captures its initiating category. Real document/store integration and correlated runtime tests establish direct-callee trust. |
| `updateRegistration` | Command, selected project/targets and runtime effects | Rename config/remote precedes state update. Failed update attempts previous-name restoration; failed restoration retains RENAME_ROLLBACK plus both categories. Successful path still mutates selected Project name only after persistence. Observation/document/store capabilities retain existing tested contracts. Repoint policy unchanged. |
| `activateDeployment` | Caller-owned candidate, borrowed previous plan, named activation intent, injected runtime effects to completed Target | Mutates candidate incomplete/recovery/desired fields exactly as before. Checkpoint acquired before pending publication; previous stop/retirement before candidate up; committing published before checkpoint commit; final publication removes recovery. A commit-finalization error never invokes rollback or claims previous restoration. Stops both plans before rollback; blocked publication precedes wrapped failure. Secondary publication failure retains its prior public failure precedence and primary/latest recovery category. Existing lifecycle/effect/store integration verifies callees. |
| `persistTarget` | Target and update-only store capability to void | Store transaction owns replacement/insertion and persistence. Caller controls snapshot lifetime; helper does not clone, read ambient state, or acquire unrelated capabilities. Existing FileStateStore and injected store tests cover trust. |
| `stopForRecovery` and runtime command callers | Existing target/dependencies; pass store directly and convert noUp at command boundary | Same pending/blocked rollback versus committing finalization policy. No-up still skips activation and existing completed same-Commit outcomes remain unchanged. Existing #77/#78 regression tests protect recorded policy and recovery. |
| Runtime `execute` / nested `record` | Command and injected dependencies; error categories alongside error code | Activity written before diagnostic; activity-write failure still attempts diagnostic. Diagnostic rejection cannot replace operation failure. Operation identity, existing activity mutation and clock/store dependencies unchanged. Composition adapter already spreads safe event fields into file log; verified via runtime→HTTP and file test plus existing transport/CLI tests. |
| `diagnosticRecord` | Borrowed DiagnosticEntry/source/timestamp to owned flat record | Existing metadata allowlist unchanged; only two finite fields added. No I/O, raw cause serialization or mutation. File writer owns filesystem/logging-failure policy and is covered by existing failure/rotation tests. |
| New test bodies | Isolated fixtures, explicit injected failures and fixed expected outcomes | Tests observe public runtime command outcomes, state, allowed effect order, real localhost response and written diagnostic. Fixture store mutation is intentional; no hidden production state. Server and temporary directory cleaned in finally. |

Inherited scope: lifecycle/provider wrappers outside registration/Deployment may
still summarize their own nested failures. This ticket does not add a recursive
cause chain or change their recovery policy. On three failures (work, cleanup,
blocked-state persistence), metadata retains primary work and the latest recovery
failure, preserving existing persistence-failure precedence. Diagnostic categories
are intentionally coarser than arbitrary provider codes. No arbitrary OS errno
mapping is inferred from untrusted objects. No full suite, standalone build,
review agents or merge were run by this implementer; supervisor owns those gates.

## Red / green evidence

1. Public failed deploy test initially failed with missing primary/recovery fields
   for DEPLOY_ROLLBACK_BLOCKED; after implementation it passes with `health` and
   `unexpected` and persisted `blocked` recovery.
2. Public initial registration test initially observed `rig` instead of `storage`
   when registration and activity persistence failed. Capturing the cause in
   `registerProject` made it green without changing files-preserved guidance.
3. Fault matrix passes for registration persistence/rename rollback, candidate
   activation, successful rollback, checkpoint rollback, commit finalization,
   previous-plan restoration, activity persistence and rejecting diagnostic sink.
4. Cyclic objects, null, strings, throwing prototype proxy, secret-bearing errors,
   arbitrary cause fields and secondary `throw undefined` emit only allowed
   categories; no raw values are serialized.
5. Complete correlated failed request: real localhost `/v1/command` returns
   DEPLOY_ROLLBACK_BLOCKED and the existing down/logs hint. Its file entry contains
   `operationId: correlated-cause`, `outcome: failed`, `code:
   DEPLOY_ROLLBACK_BLOCKED`, `primaryCause: health`, `recoveryCause: unexpected`.
   Both response and file are asserted free of the injected secret markers.

Focused gate (isolated `RIG_ROOT=/tmp/rig89-validation.rig`): **106 tests passed,
585 assertions**, across runtime-application, deployment-effects,
project-registration, file-log, transport, runtime-review-regressions,
effect-preparation and cli/cli test files. This includes existing #77 no-op and
#78 preparation recovery checks. After final malformed-error hardening and the
additional non-Error double-failure case, affected runtime/diagnostic/CLI/transport
files were rerun: **62 tests passed, 414 assertions**. `bunx tsc --noEmit` and
`git diff --check` passed. Initial unprivileged localhost runs reported sandbox
EADDRINUSE; authorized isolated reruns passed. An initial missing yaml dependency
was resolved by linking the existing shared node_modules (ignored by Git).

## Review correction — malformed failures at the diagnostic caller

Spec review at `ec7cba7` found the classifier was total but its runtime caller
still performed unchecked `instanceof RigError`/`.code` inspection before both
normal and fallback diagnostic attempts. A throwing prototype proxy therefore
replaced the initiating failure after successful rollback and emitted no evidence.
The new public runtime regression reproduced this exact identity failure in both
normal-activity and failed-activity-persistence paths before the fix.

`diagnosticErrorCode(unknown): string` now owns guarded, bounded outer-code
inspection. It borrows the throwable, retains nothing, performs no I/O or mutation,
and returns an existing uppercase bounded Rig code or UNEXPECTED. Both prototype
inspection and code access are inside its guard. Its direct caller, runtime
`execute`, extracts code and classified causes once and preserves `throw error`.
The callback invocation and await in both runtime `record` and its fallback are
inside try/catch; this covers synchronous throws as well as rejected promises.
Previously `.catch()` protected only a successfully returned promise. These
functions retain their existing injected store/clock/diagnostic dependencies,
activity-first ordering, return channels and recovery ownership. The test seam
controls the callback and store failures; original throwable identity, completed
rollback, cleared recovery, stopped intent and one bounded correlated diagnostic
are directly asserted. No failure text is inspected or copied.

Equivalent inspection in the touched path was checked: causal field extraction
already guards getters; both primary and fallback code reads now use the total
helper, and both callback invocations are fully guarded. Source-branch policy and
background reconciliation catches outside this operation failure-reporting path
are unchanged; their broader error policy remains outside this correction.

Tests also cover a throwing `.code` getter on a RigError, each activity path with
a synchronously throwing sink, and successful registration with a synchronous
sink failure. Five new public cases passed. Final focused runtime, diagnostic,
CLI and real localhost transport gate: **67 passed, 440 assertions** with
`RIG_ROOT=/tmp/rig89-review-final.rig`. Strict TypeScript and diff checks passed.

## Review correction round 2 — total recovery projection

Both reviews at `b7f62b4` found that recovery normalization could inspect a
malformed RigError outside a guard after `asRigError` returned it unchanged.
Four public double-failure regressions (pending STATE_READ followed by rollback
RigError with throwing code/message/hint/details getter) all failed before the
fix, returning the inspection error instead of safe guidance and both categories.

`retainFailureCauses` now derives both categories from the original inputs first,
then performs the entire public error projection inside one guard. It snapshots
all four copied fields, checks their types without coercion, and constructs a new
RigError only for a valid projection. A throwing getter, invalid field type or
failed normalization uses the fixed UNEXPECTED public message/hint and empty
details while retaining both original cause categories. It does not traverse
borrowed details, error stacks, nested causes or arbitrary properties. Known
well-formed outer codes/messages/hints/details retain their previous behavior.
Successful rollback still bypasses this normalizer and rethrows the original
initiating value, including the malformed values covered in round 1.

Ledger updates: `retainFailureCauses` treats the return from `asRigError` as
untrusted borrowed provider state, even if its prototype is RigError. All reads,
validation and construction sit within the total projection contract; there is
no I/O, ambient dependency or input mutation. `unexpectedFailure(causes)` owns the
single fixed fallback policy shared with `asRigError`: caller-supplied bounded
categories to a newly owned error with no raw details. `isDiagnosticCode(unknown)`
is a pure bounded predicate shared by projection and diagnostic code extraction;
it prevents duplicate code-validation policy. These direct callees are covered
through public command and diagnostic tests. Malformed detail values are not
serialized, and readable valid detail objects retain their existing borrowed
lifetime without traversal. The existing trusted RigError contract for actual
user-safe message/hint text is unchanged.

Eight public cases now pass: each copied field with a throwing getter and each
with an invalid type (including values whose coercion would throw). They assert
pending-write then rollback order, unchanged empty inventory, safe public fallback,
both correlated categories and absence of secret markers. The existing malformed
initiating-value exact-identity and normal recovery cases also pass. Focused gate:
**91 tests passed, 558 assertions**, across runtime-application,
deployment-effects, diagnostic file log, CLI and localhost transport with
`RIG_ROOT=/tmp/rig89-round2-final.rig`. Strict TypeScript and diff checks passed.
