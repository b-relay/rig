# Deployment transaction and artifact ownership review

Independent review found and reproduced three material transition defects plus an
adjacent installed-status defect. Fixes were then authorized and implemented with
public-behavior regressions. No live Host state was changed.

## Findings and resulting contracts

1. **Completed inventory preceded effect commit.** The old sequence cleared
   recovery and persisted the candidate, then committed its effect journal. A
   process crash between those writes allowed explicit down to restore old
   executable/route bytes while inventory still named the new Commit. Deployment
   now persists a durable `recovery.stage = committing` decision before committing
   effects. It clears recovery only after effect commit. A recreated daemon can
   finish that decision through `commitEffects`; explicit down stops candidate
   processes and retains candidate plan/artifacts. Pending/blocked decisions
   instead restore the previous effects and previous plan. First deployments
   also retain a recovery record, so they have the same proof boundary.
2. **Retirement committed before inventory removal.** An inventory write failure
   could leave a desired-running record with its executable/routes deleted and
   no rollback handle. Retirement now accepts the explicit inventory-publication
   callback inside its effect transaction. A callback failure restores saved
   effects and restarts the previous Target when it was desired running. After
   inventory removal commits, checkpoint finalization failure preserves the
   deletion and reports `RETIRE_COMMIT_PENDING`; it never recreates orphaned
   runnable executables without inventory.
3. **Removed installed Components left orphan executables.** A successful deploy
   snapshotted only candidate Components. Removing a Component or changing its
   installName left the old destination permanently owned but absent from the
   recorded plan. Deployment now checkpoints the union of candidate destinations
   and superseded old destinations, then retires old destinations under verified
   ownership before candidate activation. Shared receipt paths are deduplicated.
   Failed activation restores those bytes and receipts with the old plan.
4. **`--no-up` could certify the previous binary for the new source.** Ownership
   alone was sufficient for `installed`, despite a candidate plan whose workspace
   and Commit had changed without installation. Observations now validate the
   saved receipt against the recorded plan's installation policy, source identity
   and owned artifact digest. Mismatched evidence reports `unknown`. Later up
   installs the candidate and makes status `installed`. This compares the saved
   Target plan, never newer current Project config.

## Boundary ledger and failure ownership

- `activateDeployment` receives both plans and runtime capabilities. It owns the
  durable commit decision and inventory publication ordering. Errors before the
  decision attempt rollback; errors after the decision leave explicit committing
  recovery and cannot choose rollback.
- `stopForRecovery` acts on the durable stage. Its successful result includes the
  exact plan matching retained/restored executable effects, with desired stopped.
- `TargetLifecycle.retire` owns stopping processes, checkpointed effect deletion,
  the supplied inventory mutation, and compensation. The callback is an explicit
  effect in its contract, not hidden ambient storage.
- Effect transactions own only snapshotted binary/owner/receipt/route paths and
  preserve expected digests. A recreated adapter verifies expected hashes before
  committing recovery. External edits are preserved and fail closed.
- The Target effects adapter owns installation-policy digests, retired path
  selection, receipt inspection and concrete file/provider operations. Runtime
  code does not learn filesystem ownership-record layouts.

## Validation and practical limits

Focused transaction/lifecycle/application/Target-adapter validation passed:
**37 tests, 146 assertions**, including restored-artifact observation. Strict source-and-test typecheck passed. Regression coverage includes
stopped previous rollback; state publication failures; first deployment; commit
finalization failure; recreated-adapter recovery; retirement inventory failure;
retirement finalization failure; removed Components and changed installName;
external artifact edits; cross-Target and unmanaged destination collisions;
`--no-up` followed by up; and current source-shim edit behavior.

A process crash between an external file write and saving its new expected digest
cannot be mistaken for a verified complete write. Recovery reports
`EFFECTS_CHANGED` and retains the checkpoint for explicit inspection. It does not
silently overwrite bytes or claim successful recovery. Similarly, checkpoint
finalization failure after a successful inventory deletion may retain archived
backup evidence without a live Target. It must not cause automatic resurrection.
This transaction protocol addresses process interruptions; it does not claim
power-loss durability beyond the filesystem's atomic rename guarantees.

Self-deployment still requires the reviewed live rollout ordering: use an
immutable staged daemon and prevent the legacy Rig plan from replaying before
installing the new release. Transaction rollback preserves installed bytes; it
does not substitute for that source/version cutover decision.
