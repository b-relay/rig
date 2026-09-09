# Rig tickets #64–73: implementation acceptance audit

Reviewed release: [`087ce3b84da0b2afef61f2886839474106e8b0ac`](https://github.com/b-relay/rig/commit/087ce3b84da0b2afef61f2886839474106e8b0ac).

This September 9, 2026 audit compared the current GitHub issue bodies and comments
with that frozen release's implementation and test assertions. **No unmet issue
Expected criterion was found in the new implementation.** This is an inspection
result, not a fresh test run: tests were not rerun for this audit. All ten issues
were open when read, and this audit changed no GitHub state.

Paths and line numbers below refer to the reviewed commit. Test references name
actual behavioral assertions, not proposed coverage. Separate release validation
and live rollout evidence must establish that the tested code is deployed and
existing Projects have been updated. The subsequent live rollout is recorded in [the final results](2026-09-09-live-rollout-results.md).

## Issue-to-implementation mapping

| Issue and expected behavior | Implementation | Existing acceptance evidence |
| --- | --- | --- |
| [#64](https://github.com/b-relay/rig/issues/64): local uses the checked-out working copy rather than an empty managed directory | `src/runtime/targets.ts:58` starts with the registered repository as the local workspace; only non-local Targets materialize source. `src/runtime/lifecycle.ts:162` and `src/adapters/target-effects.ts:107` use that recorded workspace for processes and hooks. | `tests/runtime-application.test.ts:140` asserts the actual repository workspace and recorded-policy reuse. `tests/rig-e2e.test.ts:14` starts a real application whose HTTP response reports its actual cwd. |
| [#65](https://github.com/b-relay/rig/issues/65): down terminates owned processes and fails when termination is uncertain | `src/providers/child-supervisor.ts:178` stops and verifies owned process groups. `src/runtime/lifecycle.ts:203` attempts every managed Component and distinguishes process-stop failure from hook failure. The daemon, rather than the invoking CLI, owns runtime processes. | `tests/rig-e2e.test.ts:14` uses separate CLI clients and confirms the port is released. `tests/providers-process.test.ts:60` verifies shell-descendant termination; `:149` verifies replacement-daemon adoption and stop. `tests/runtime-application.test.ts:292` verifies failed stop cannot make reconciliation resurrect a Target. |
| [#66](https://github.com/b-relay/rig/issues/66): partial up preserves already-running Components | `src/runtime/lifecycle.ts:144` skips running Components; `:181` rolls back only newly started processes. `src/providers/launchd-supervisor.ts:72` observes the job before deciding whether startup is needed. | `tests/runtime-lifecycle.test.ts:47` verifies a healthy existing Component is not stopped when another startup fails. `tests/providers-launchd.test.ts:12` verifies already-running launchd jobs are not restarted. |
| [#67](https://github.com/b-relay/rig/issues/67): live crashes receive a restart policy and/or truthful current health | `src/runtime/lifecycle.ts:165` selects configured KeepAlive policy, defaulting to enabled. Process/capture providers apply bounded restart behavior. `src/runtime/status.ts:50` probes current process presence and configured health instead of presenting historical desired state as observed health. | `tests/providers-process.test.ts:212` and `tests/providers-capture.test.ts:48` verify bounded restart behavior. `tests/runtime-status.test.ts:79` distinguishes a crashed desired-running process from an intentional stop; `:23` distinguishes failing health from running without a check. `tests/activity-crashes.test.ts:41` verifies persistent, deduplicated terminal-crash activity. |
| [#68](https://github.com/b-relay/rig/issues/68): supported Project rename/repoint without rewriting historical events | `src/cli/commands.ts:61` and `:74` expose rename/repoint. `src/runtime/registration.ts:6` requires stopped, known Targets and updates the current registration directly. Stable Target identities and storage survive; rename coordinates config and Git-remote compensation. | `tests/full-project-e2e.test.ts:20` exercises stopped rename, repository move, repoint, all Target restarts, and preserved SQLite identities/content. `tests/runtime-application.test.ts:221` handles a missing old path. `tests/runtime-review-regressions.test.ts:61` verifies canonical paths through symlinks. `tests/git-project.test.ts:108` verifies fetch/push remote updates and guarded compensation. |
| [#69](https://github.com/b-relay/rig/issues/69): deployment source does not depend on the developer repository's Git administration | `src/providers/git-source-store.ts:64` creates an owned mirror using `--no-hardlinks` and `--dissociate`, fetches the resolved Commit, and adds deployment worktrees against the owned object store. | `tests/providers-git.test.ts:26` deletes the developer repository and verifies the deployed Git workspace remains complete. `:70` tests a source clone that itself borrowed objects. `tests/deployment-e2e.test.ts:6` moves the developer repository and verifies lifecycle and Git integrity still work. |
| [#70](https://github.com/b-relay/rig/issues/70): one Project identity rule, with remote conflicts named accurately | `src/adapters/project-documents.ts:117` treats existing config name as authoritative during initialization. `src/runtime/projects.ts:41` selects by the discovered config name. Git remotes are checked for compatibility rather than used to silently override config identity; `src/git/remotes.ts:161` reports `GIT_REMOTE_CONFLICT`. | `tests/project-registration.test.ts:104` verifies nested initialization uses the canonical Git root and existing config identity. `:161` verifies a requested name conflict fails before writes. `tests/git-project.test.ts:61` verifies conflicting fetch or push destinations are preserved and reported explicitly. |
| [#71](https://github.com/b-relay/rig/issues/71): failure-sounding doctor findings are non-ok | `src/runtime/doctor.ts` and `src/adapters/host-inspection.ts` construct separate passing and failing checks. Failure reasons are attached to failing checks; aggregate `ok` requires every check to pass. Host observations remain available when Project discovery fails. | `tests/runtime-review-regressions.test.ts:83` verifies pending ownership is non-ok alongside independent Host observations; `:105` verifies invalid Project discovery is non-ok without suppressing Host checks; `:120` verifies unresolved deployment recovery cannot appear healthy. `tests/deployment-e2e.test.ts:104` verifies an unreachable daemon produces a failing offline doctor result. |
| [#72](https://github.com/b-relay/rig/issues/72): status JSON, preferably lifecycle JSON, uses the same result as human output | `src/cli/commands.ts:48`, `:114`, and `:171` expose scoped JSON on status, lifecycle, and deploy. `src/cli/rig.ts:37` either serializes the returned result or passes that same result to human rendering. | `src/cli/cli.test.ts:37` verifies correlated structured status/lifecycle requests. `tests/rig-e2e.test.ts:14` and `tests/full-project-e2e.test.ts:20` parse actual CLI JSON responses across status, lifecycle, and deployment. |
| [#73](https://github.com/b-relay/rig/issues/73): lifecycle actions preserve deployed Branch/Commit metadata | Lifecycle updates retain the recorded Target plan and source fields; `src/runtime/status.ts:166` returns recorded Branch/Commit. Deploy is the operation that creates a new source plan. | `tests/runtime-application.test.ts:156` verifies deployment source survives down/up and same-Commit deployment is a no-op. `tests/deployment-e2e.test.ts:6` verifies actual Branch/Commit status after down/up, including changed current config that must not replace recorded deployment policy. |

## Acceptance distinctions

- **#65 records intent before signaling, not success before verification.** The
  runtime persists desired stopped intent first so interrupted shutdown cannot
  make reconciliation resurrect the application. A stopped success response
  requires verified provider shutdown; status uses current observations. A
  capture process surviving a daemon crash retains recoverable ownership rather
  than becoming an untracked CLI orphan.
- **#67 does not require a particular launchd plist boolean.** Capture-backed
  launchd jobs can use `KeepAlive=false` because the capture wrapper owns bounded
  application restarts. The issue explicitly accepts truthful current
  process/health reporting as an alternative, and the release implements both
  bounded recovery and fresh status.
- **#68 does not require deregistration.** Its Expected section asks for a
  supported rename or repoint operation; both are implemented. Destructive
  Project deletion is not implied by that wording.
- **Existing legacy state needs explicit rollout work.** The new local workspace
  and independent-source contracts do not by themselves rewrite old recorded
  supervisor cwd paths or repair Pantry's broken historical Git anchor. That
  evidence belongs in the live rollout record, preserving legacy bytes and
  application data.

## GitHub comments and external Pantry documentation

A read-only GitHub GraphQL query fetched comments for issues #64 through #73;
**each returned zero comments** at audit time. There is no comment-based promise
to update an external Pantry document.

Issue #72's body has a **Related drift** section reporting that Pantry's
`CLAUDE.md` used obsolete positional Project and `dev`/`prod` command forms. Its
Expected section requests scoped JSON from the same read model; it does not add
an explicit external documentation acceptance criterion. Issue #64 also links
an external Pantry ticket and Supervisor verification, without promising an
external document change.

This distinction does **not** narrow the user's separate instruction to update
existing Rig projects. The rollout should inspect the current Pantry guidance
and correct stale examples where present, using forms such as
`rig status --project <name>` and `rig restart live --project <name>` while keeping
Pantry and pantry2 identities separate. This audit did not inspect or modify
those external documents and does not claim that follow-up is complete.
