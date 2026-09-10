# Function honesty tree — independent Codex reassessment

Reviewed source: **`83496f8dafde3909a7a7121ef496aeae4dacd2ef`**, September 10, 2026. This is an independent source review after the fixes, not a live-rollout report. No production files, runtime state, processes, launchd jobs, or Caddy configuration were changed. No tests were run for this review.

I read current `AGENTS.md`, `CONTEXT.md`, `docs/PRD.md`, the function-design skill and all three references, and the September 9 tree A and tree B (`2026-09-09-function-honesty-tree-a.md` and `2026-09-09-function-honesty-tree-b.md`, retained locally). Prior trees supply the comparison baseline; current source supplies the verdict. I did not read the concurrent Fable report before completing this report.

## Assessment

The tree is materially better. The former resolver cwd dependency, Git canonicalization seam, permission-fallback command runner, buffered-log clock, and CLI follow timer have explicit boundaries now. Status preserves rejection versus deadline expiry. Observation and readiness timing can be controlled through their actual public consumers, rather than by patching platform timers. Status also has a shared validated result contract across runtime, client, picker, and presenter.

The remaining concerns are mostly **incomplete result/failure contracts and narrower substitution limits**, not a spread of arbitrary ambient I/O through business logic. The strongest remaining result-contract problem is that commands other than Status still accept arbitrary successful reply bodies and presenters can turn missing fields into empty inventory/log/activity claims. Doctor still takes multiple versions of the same config during one report. Retirement errors still lose causal categories that deploy/registration now preserve. These are detailed below without treating all effects as bugs.

This is a comprehensive map of the major execution paths, not an exhaustive census of every function or a numerical honesty score. A listed module has not thereby passed every function-design step. The scope and depth table records the distinction.

## Legend and observation boundary

- **H** — value computation or authorized mutation whose inspected dependencies/results are explicit. Mutating caller-supplied state can be honest.
- **C** — capability composition: supplied providers, callbacks, store, clock, or output are explicit. Their I/O, blocking, failure, and mutation remain part of the composed call. C never means pure.
- **O** — intentional effect owner: executable/composition root, framework hook, transport, filesystem/process adapter, or explicitly selected production scheduler. It contacts the outside world by design.
- **D** — hidden or insufficiently expressed dependency below the claimed boundary.
- **T** — transitive qualification inherited through the indicated callee.
- **?** — dependency internals or behavior not proved in this review.

Classifications apply to calls, not merely imports. A factory that captures supplied state is not dishonest merely for creating a closure. Immutable schemas, hash algorithms, and fixed lookup policy are ordinary calculation inputs in this practical review boundary; allocation, standard Promise bookkeeping, and library implementation details are not treated as application effects. Framework-owned Request values and required callbacks are explicit inputs. Default OS adapters remain effect owners even when their constructor offers some test substitutions.

“First crossing” below identifies the first relevant concrete acquisition or information-loss edge. A caller supplied with a declared filesystem or HTTP capability does not become hidden debt merely because that capability performs its stated job.

## 1. CLI and remote protocol trees

```text
O index.main(args)                                           src/index.ts:10
  O rigRoot / userOutput / cwd / signals / UUID / clock        cli/entry-environment.ts:5; index.ts:11
  O createCliClient(root, capturedCwd)                        index.ts:47
    O connectDaemon(root)                                    daemon/connection.ts:6
      O readDaemonAddress + readDaemonToken                  daemon/files.ts:50,57
      O DaemonClient.status / command -> request -> fetch     daemon/client.ts:42,60,72,79
    H isDaemonUnavailable(error)                             daemon/connection.ts:21
    O Doctor-only inspectOfflineHost(root, requestPath|cwd)   index.ts:57; daemon/offline-doctor.ts:12
  O createHostDiagnosticLog -> lazy Host config + file log    diagnostics/host-log.ts:8,14
  O createTerminalInteraction(streams, signal)                adapters/terminal-interaction.ts:14
  O waitForLogPoll(milliseconds, signal)                      adapters/log-follow-scheduler.ts:2
  C runRigCli(args, dependencies)                            cli/rig.ts:10
    C createRigCommand(cwd, output, execute)                  cli/commands.ts:19
      H argument/request construction, validated selection
      ? Commander parsing/action dispatch (tests, not library internals)
    C prepareInteractiveRequest(request, deps)               cli/interaction.ts:25
      C supplied picker/confirmation, status/deploy-context, output, signal
    C client.status -> typed ProjectStatusReport             cli/rig.ts:36
    C client.command -> unknown result                       cli/rig.ts:39 [F1]
    H renderStatus(report)                                   cli/output.ts:35
    H renderResult / renderLogs (total but lossy input policy) cli/output.ts:3,95 [F1]
    C diagnostic/output effects                              cli/rig.ts:22,40,47
    C followLogs(request, initial, deps)                      cli/rig.ts:88
      C required deps.wait, client.command, output; opaque cursor
    C reportFailure / recordDiagnostic                       cli/failure.ts:51,33

O git/remote-helper.main(args)                                src/git/remote-helper.ts:310
  O cwd + stdin + output + ID/diagnostic clock acquisition
  O createProjectDiscovery(runCommand)                      git/project.ts:32
    O canonicalize: realpath; captured environment/LC_ALL     git/project.ts:33,35
  C inspectProjectGit(path, discovery)                       git/project.ts:169
    C inspectProjectLocation -> canonicalPath/readGit        git/project.ts:95,41,75
    H branch/default selection, canonical absolute-path validation
  C runRemoteHelper(url, dependencies)                       git/remote-helper.ts:66
    H URL/ref/frame parsing                                  git/remote-helper.ts:228,238,253
    C source.resolve / verifyBranch -> supplied runner        git/remote-helper.ts:264
    O entry-owned client.command -> connectDaemon(root)      git/remote-helper.ts:341
    C protocol output + diagnostics + operation IDs
    H completed/no-op reply checks before reporting push success
```

**Boundary changes:** the first CLI log scheduling crossing is now the entrypoint's supplied `wait`, implemented by the named scheduler at `adapters/log-follow-scheduler.ts:10`; `followLogs` contains no fallback timer. The first discovery filesystem crossing is now `createProjectDiscovery`'s `canonicalize: realpath`, not an extra `realpath` buried inside `inspectProjectGit`. Its methods can operate over fictional paths with a supplied discovery capability.

The normal CLI and Git helper share fresh address/token acquisition. Doctor's offline fallback remains deliberately local to the normal CLI; authentication, corrupt metadata, and protocol errors are not unavailable-daemon conditions. Captured cwd is reused. This is shared mechanism with different explicit policy, not a reason to merge all callers into a configurable universal client.

The remote protocol loop is still a strong C subtree: its input stream, source resolution, daemon operation, output, diagnostics, and IDs are supplied. Its own reply checks mean F1 does not imply an arbitrary response is accepted as a successful Git push.

## 2. Daemon, authority, and runtime trees

```text
O rigd.main(args)                                            src/rigd.ts:10
  O capture branch -> runCapturedProcess(path)                providers/captured-process.ts:19
    O signals, identity checks, child supervision, observation files, wall clock
  O admin branch -> DaemonAdmin                              daemon/admin.ts:48
    C runRigdCli(args, admin/output/diagnostics/id)            cli/rigd.ts:14
    O status/install/uninstall                               daemon/admin.ts:61,96,101
      O metadata + token + health + process/launchd + Activity
      O launchctl -> Bun.spawn                               daemon/admin.ts:299 [S4]
  O daemon child -> composeDaemon(root, captureCommand)       daemon/composition.ts:31
    O Host config, environment, IDs, clocks, provider choice
    C createRuntime(deps)                                    runtime/application.ts:49
      C command -> read path or mutation queue -> execute     runtime/application.ts:525,65
        C ownership guard before mutation                    runtime/application.ts:81
        C selectProject / registerProject                    runtime/projects.ts:8,57
          C documents discovery/read/init; store read/update; ID/time
          H/T identity and registration policy; relative restored paths -> D [S3]
        C planTarget(input, deps)                            runtime/targets.ts:40
          H targetName / recordedPorts                       runtime/targets.ts:13; runtime/ports.ts:3
          C source preparation, Host policy, inventory, selected ports, ID/time
          H documents.resolve -> resolveTargetPlan           runtime/targets.ts:165; config/resolve.ts:70
        C activateDeployment(candidate, previous, intent, deps) runtime/deploy.ts:19
          H assertDeploymentRecovered                        runtime/deploy.ts:7
          C checkpoint -> pending record -> stop/retire old -> activate/prepare
          C committing decision -> checkpoint commit -> completed record
          C rollback/restore with bounded safe causes
        C up/down/restart existing record -> lifecycle       runtime/application.ts:415
        C destroy -> staged retirement/deletion              runtime/application.ts:361; tree 4
        C status / list / doctor / registration -> observations
        C logs -> files.logs(target, cursor, limit)
        C finish/record -> Activity + diagnostics             runtime/application.ts:455,486
      C exclusive(operation) / drain / reconcile              runtime/application.ts:509,505,531
    C createConfigEditor({documents, resolveProject, exclusive}) daemon/composition.ts:115
    O start interval callback                                daemon/composition.ts:131,134
      C runtime.exclusive -> monitorRuntimeFailures           daemon/composition.ts:138; runtime/activity.ts:20
    O shutdown hook -> drain + provider shutdown              daemon/composition.ts:152
  O runDaemonHost(options)                                   daemon/host.ts:17
    O acquisition guard, owner PID/UUID, files, address publication, signals
    O startControlPlane(options) -> Bun.serve/fetch hook       daemon/server.ts:20,23
      H authentication / request schema / error envelope
      C supplied handle/editor
      O /health obtains process.pid                          daemon/server.ts:53
```

Runtime queue and captured state are explicit instance state. `store.update` is an authorized mutation channel. `FileStateStore.read()` returns newly parsed data; update reads again, applies the callback, validates, and renames the replacement (`runtime/state-store.ts:22,64`). One daemon owns writes; the host lease supplies cross-process exclusion. The store's per-instance Promise queue is not itself cross-process locking, and atomic publication is not a guarantee that arbitrary callback effects roll back.

The framework HTTP handler owns accepting requests and creating responses; process identity in its health response belongs to that intentional adapter. I do **not** carry forward tree B's suggestion that a framework health handler reading its PID is by itself hidden business-logic debt. Likewise the composition interval and process signal callbacks are expected event owners. Their failures and supplied operations remain part of their contracts.

### Observation and readiness subtrees

```text
C observeTargets(targets, effects, budget, deadline?)         runtime/status.ts:38
  C boundedObservations(jobs, budget, deadline)               runtime/bounded-observations.ts:24
    C supplied deadline.schedule / cancellation               bounded-observations.ts:33,69
    C supplied jobs(signal); completed | rejected | expired
    H first settlement / ordered results / late-result exclusion
  H component result mapping and aggregate                   runtime/status.ts:120,140
  O when omitted: timerObservationDeadline.schedule           bounded-observations.ts:9

C monitorRuntimeFailures(options)                            runtime/activity.ts:20
  C store.read -> boundedObservations -> store.update         runtime/activity.ts:23,31,72
  H concrete-exit selection / hash identity / generation and duplicate recheck
  C supplied now() for retained Activity timestamp            runtime/activity.ts:95
  O default deadline selected explicitly at options boundary  runtime/activity.ts:39

C createTargetLifecycle(effects, timing?)                     runtime/lifecycle.ts:84
  C up(record, optionalCheckpoint)                            runtime/lifecycle.ts:141
    H provider profile / checkpoint Target identity validation
    C checkpoint/prepare/install/observe/hooks/start/environment
    C awaitReady(component, target, health, timing)            runtime/lifecycle.ts:299
      C scheduled deadline and 100ms retry, provider health(signal)
      H success/rejection/expiry selection; release scheduled work
    C route/post-start/commit; rollback only owned progress
  C down(record)                                             runtime/lifecycle.ts:226
    C observe/stop + hooks; stopped/unchanged or distinct STOP_HOOKS/STOP_INCOMPLETE
  C stopForTransition -> interpret only STOP_HOOKS as stopped runtime/lifecycle.ts:342
  O default readinessTiming.schedule                         runtime/lifecycle.ts:76
```

**Exact transitive qualification:** `projectStatus` calls `observeTargets(selected, deps.observations)` at `runtime/project-status.ts:51`; Doctor does so at `runtime/doctor.ts:156`; registration at `runtime/registration.ts:13`; list/uninstall use the same operation at `runtime/application.ts:92,120`. Those callers choose the documented default implicitly. Thus a fully faked `RuntimeDependencies` does not give a test control of the observation deadline. The first timer acquisition is `timerObservationDeadline.schedule -> setTimeout` at `runtime/bounded-observations.ts:11`, reached through the visible default argument at `runtime/status.ts:42`.

This is **T(default O)**, not the old uninjected-timer defect: the real observation consumer and failure monitor now accept time substitution, and the shared batch has no ambient timer. Lifecycle likewise accepts timing at construction; its internal readiness helper uses only that capability. Moving timing into composition for every higher-level read caller would be optional additional isolation, not a demonstrated correctness fix or a reason to thread timer machinery through pure report functions.

## 3. Concrete providers, logs, and config trees

```text
O createTargetEffects(options) methods                       adapters/target-effects.ts:57
  H supervisor selection / installedPath / installationPolicyKey
  O environment -> readEnvironment                            target-effects.ts:86,495
  C runTarget -> supplied run                                 target-effects.ts:98,106
    O recordOutput -> supplied recordingTime + mkdir/append    target-effects.ts:116,128,136
  O health -> fetch or supplied command runner                target-effects.ts:142,150,157
  O prepare -> storage creation/dependency preparation        target-effects.ts:243
  O install -> ownership + build + installer + receipt/capture target-effects.ts:340
  O route/removeRoute -> supplied router + transaction capture target-effects.ts:405,429
  C process observation -> selected supervisor                target-effects.ts:437
  O artifact/persistent observation -> files/ownership/env     target-effects.ts:440,481

O createChildSupervisor(options)                              providers/child-supervisor.ts:56
  O recover / observe / start / output / lease / restart queue
  O stop -> inspection identity/group/signal + wall-time waits child-supervisor.ts:177 [F4]
    C supplied ProcessInspection or default concrete owner    child-supervisor.ts:67
      O createProcessInspection({run?, kill?})                providers/process-inspection.ts:29
        C groupExists -> supplied kill -> EPERM supplied run  process-inspection.ts:36,44
        C signalGroup -> checked group evidence               process-inspection.ts:63
  O capture subprocess handshake                              providers/capture-status.ts:35
O createLaunchdSupervisor(options)                            providers/launchd-supervisor.ts:31
  O observe -> launchctl + readCaptureObservation              launchd-supervisor.ts:47,66
  O ensureRunning/stop -> plist, capture, launchctl, polling    launchd-supervisor.ts:102,155
  H launchdPlist/xml values                                    launchd-supervisor.ts:206,198
O createGitSourceStore -> source mirror/worktree, files, runner providers/git-source-store.ts:20
O createArtifactInstaller -> compile/shim, files, tool lookup  providers/artifact-installer.ts:29
O createCaddyRouter -> owned blocks, revision/backup/reload     providers/caddy-router.ts:23
  H routeMarkers / ownedBlock / hostname matching              caddy-router.ts:192,198,177
O runCommand(request) -> process group/output cap/timer         providers/command-runner.ts:5

O RuntimeFiles.selectPorts                                    adapters/runtime-files.ts:11
  O availablePort -> localhost bind -> close -> number         runtime-files.ts:32,44,47
O RuntimeFiles.logs -> readTargetLogs                          adapters/target-log-reader.ts:58
  O readSource -> bounded file reads                          target-log-reader.ts:156
  H decodeCursor / parseLine / compareEntries                 target-log-reader.ts:135,222,255
  H per-source cursor progress, materialized bounded window

O config document read/discover/init/edit                     config/documents.ts:163,177,208,286
  H decodeDocument / prepareEdit                              documents.ts:112,247
  H applyYamlEdits / applyJsonEdits                            config/editor.ts:19,68
  O revision/lock/backup/temp publication                      documents.ts:293,309,322,336
C config editor handler                                      daemon/config-editor.ts:156
  H request/path/schema policy, typed edit request, diff
  C resolveProject + documents.read/preview/apply + exclusive
H resolveTargetPlan(input)                                   config/resolve.ts:70
  H reject nonabsolute workspace/data roots before resolution config/resolve.ts:71
  H parseProjectConfig / interpolation / hooks / dependency order
  H path.resolve with established absolute base; no cwd acquisition
```

Supplied command execution does not make a concrete artifact, process, or routing adapter filesystem-free. That is their job. `runTarget` also inherits the file-write channel of `recordOutput`; calling only the runner “injected” would be an incomplete ledger. The timestamp channel is now separately named and acquired per retained line after buffered execution. It does not claim original stdout/stderr interleaving.

The log reader owns bytes, identity, truncation and cursor failure. `Date.parse` in ordering is a calculation on the entry's timestamp, not a wall-clock read. Unknown legacy time and stream values remain explicit. Follow treats the cursor as opaque; it does not turn repeated text into record identity.

Port selection returns numbers after closing probe sockets. `RuntimeFiles.selectPorts` now states configured versus dynamic policy, supplied inventory exclusions, partial-failure release, and absence of a transferred socket lease (`runtime/contracts.ts:70`). Startup and health remain separate evidence. The name and shared contract now agree with the concrete bind/close behavior.

Config preview is read-only, not pure: it acquires current bytes before applying pure edits. YAML/JSON edit helpers mutate their supplied private representation and can reject; the filesystem owner decides publication. Imported schema/field tables in `daemon/config-editor.ts:104,145` are fixed derived policy, not mutable ambient business state. No extraction solely to remove import-time calculation is justified here.

## 4. Recovery and explicit Preview destruction

```text
C activateDeployment                                         runtime/deploy.ts:19
  C matching Target checkpoint + durable pending/committing state
  C stopForRecovery -> stop both plans or finalize commit      runtime/deploy.ts:134
  H failureCauses / retainFailureCauses / diagnosticCauses     domain/errors.ts:118,60,129

C lifecycle checkpoint/restore/commit                         runtime/lifecycle.ts:89,93,97
  O createEffectTransactions                                  adapters/effect-transactions.ts:69
    O checkpoint -> ownership inspection + backup + journal    effect-transactions.ts:181
      O createEffectPreparation.begin/recover                 adapters/effect-preparation.ts:95,120
    O captureArtifact/captureRoute -> expected-revision writes effect-transactions.ts:256,271
    O commit/restore -> validate saved ownership and revisions effect-transactions.ts:278,314
    H target identity / phase / route equality decisions

C runtime destroy branch                                     runtime/application.ts:361
  H require Preview / existing Target; recover old transition if necessary
  C files.inspectPreviewDeletion                              application.ts:370
  C persist stopped + destructionPending retry handle         application.ts:375
  C lifecycle.retire(target)                                  application.ts:381
    C checkpoint -> verified stop -> remove route/artifacts -> commit
    C RETIRE_COMMIT_PENDING / RETIRE_ROLLBACK                  lifecycle.ts:118,132 [F3]
  O files.destroyPreview -> deletionRoot -> recursive rm      adapters/preview-storage.ts:10,13
    O canonical path / device / inventory overlap inspection  preview-storage.ts:42,74,101,108
    H within / overlaps / recordPaths                        preview-storage.ts:112,121,124
  C remove inventory only after successful deletion           runtime/application.ts:387
  C Activity/final outcome

O library-only legacy migration/read/finalize operations      migration/files.ts:121,145; adoption.ts:262
  O read source/backup/current repository evidence
  H recoverSources / convertLegacyState / validateEvidence   migration/source-evidence.ts:32; convert.ts:26; adoption.ts:203
  O backup/publication/adoption manifest
O active createAdoptionGuard(root)                            migration/adoption.ts:192
```

The destruction call explicitly authorizes an irreversible channel; it is not hidden behind ordinary `down`. The runtime saves a stopped pending record before retirement and storage removal. Deletion rechecks path ownership immediately before removing bytes; absent bytes support retry, and inventory survives a cleanup or final inventory-write failure. `down` alone still preserves data. Existing source and shared storage outside the canonical owned Preview root are not silently swept into deletion.

The first destructive OS crossing is `destroyPreview -> rm` at `adapters/preview-storage.ts:13`; the contract states irreversible partial deletion and caller-retained inventory (`runtime/contracts.ts:61`). The preceding inspection is evidence, not a transaction locking the entire external filesystem. I have not proved safety against an unrelated process modifying directory mounts/paths between inspection and deletion. This review does not upgrade checked filesystem snapshots into an atomic OS ownership proof.

Checkpoint identity and pending/committing/blocked stages encode meaningful prerequisites. They should survive simplification. The low-level recovery owner preserves an ambiguous pre-marker backup with an archive location, rather than guessing it is disposable. Compatibility conversion remains a library/admin operation; normal commands encounter the adoption guard, not automatic migration.

## First-crossing summary

| Interior caller | First crossing | Current classification |
|---|---|---|
| CLI follow | Required `deps.wait` -> entrypoint scheduler -> `setTimeout` (`cli/rig.ts:95`; `adapters/log-follow-scheduler.ts:10`) | C -> O; old hidden fallback removed. |
| Git discovery | Supplied `discovery.canonicalize` -> factory `realpath` (`git/project.ts:47,35`) | C -> O; filesystem identity is now substitutable. |
| Pure plan resolution | Absolute-root validation before `path.resolve` (`config/resolve.ts:71,161`) | H in accepted domain; old cwd crossing rejected. |
| Status/Doctor/list/registration | Default `observeTargets` deadline -> timer owner (`runtime/status.ts:42`; `runtime/bounded-observations.ts:11`) | T(default O); operation seam is explicit, higher runtime seam still selects default. |
| Buffered log recording | Required `options.recordingTime()` (`adapters/target-effects.ts:128`) | O with explicit clock; no concealed wall-clock acquisition. |
| Process stop inspection | Supplied inspection -> EPERM supplied runner (`child-supervisor.ts:210`; `process-inspection.ts:44`) | C -> O; old hardwired fallback removed. |
| Child stop/restart time | `Date.now` / `Bun.sleep` / `setTimeout` (`child-supervisor.ts:212,215,250`) | O with incomplete `now` seam (F4), separate from fixed inspection. |
| Selection from relative restored state | `resolve(project.repoPath)` (`runtime/projects.ts:46`) | Conditional D/T at schema-admitted relative path; normal acquired paths absolute (S3). |
| Non-Status transport result | Envelope validation -> unvalidated result (`daemon/client.ts:70`) | Information loss (F1), not an ambient-I/O defect. |
| Retirement failure | Caught commit/rollback failure -> new wrapper (`runtime/lifecycle.ts:119,132`) | Causal information loss (F3), not hidden OS acquisition. |

## Before/after comparison

These rows check the issue-related boundaries in source; they do not assert that this review reran each ticket's acceptance suite.

| Work | Before | Current evidence and verdict |
|---|---|---|
| #83, with the rejection distinction already fixed by #80 | Separate ambient deadline machinery; rejected observer could be described as timed out in the original trees. | `boundedObservations` takes jobs/budget/deadline and returns tagged settlement (`runtime/bounded-observations.ts:16,24`); `observeTargets` distinguishes failed/expired text (`runtime/status.ts:125`). **Fixed at the operation seam.** Higher callers still select documented defaults. |
| #84 | Readiness owned uninjected timeout/retry timers; expiration during retry could wait for retry completion. | `ReadinessTiming` and the `createTargetLifecycle` argument (`runtime/lifecycle.ts:68,84`); readiness races both provider and retry against expiry (`:307`). **Controllable lifecycle timing.** |
| #85 | Status result erased into `unknown`, picker/presenter reconstructed it independently. | Shared `ProjectStatusReport`/reader (`domain/project-status.ts:95,104`), client validation (`daemon/client.ts:43`), typed presenter (`cli/output.ts:35`). **Fixed for Status; F1 remains for other actions.** |
| #86 | Duplicated address/token/client construction; Doctor re-read cwd. | Shared `connectDaemon` (`daemon/connection.ts:6`), captured cwd in CLI (`index.ts:12,57`), helper uses same connection (`git/remote-helper.ts:341`). **Fixed.** |
| #87 | Pure resolver admitted relative roots and inherited process cwd from `path.resolve`. | Early absolute-root rejection (`config/resolve.ts:71`) before dependent resolution. **Fixed for this API.** Persisted state still uses nonempty strings (`runtime/state-schema.ts:43`); see S3. |
| #88 | Fake Git runner could not replace independent `realpath` reads. | `ProjectDiscovery` supplies canonicalization and command capability (`git/project.ts:26`); OS factory captures env/realpath (`:32`); canonical-path validation and safe failure distinctions (`:41`). **Fixed.** |
| #89 | Registration/deploy wrapper failures discarded initiating/recovery causes. | Safe bounded classification/projection (`domain/errors.ts:60,86,118,129,149`) used in `runtime/projects.ts:104`, `runtime/deploy.ts:41,76,104,124`, and correlated recording (`runtime/application.ts:433`). **Fixed in the scoped paths; retirement still differs (F3).** |
| #90 | “Reservation” implied ownership beyond a bind/close probe; interface omitted release/race contract. | `selectPorts` domain contract (`runtime/contracts.ts:70`) and owner (`adapters/runtime-files.ts:11`). **Contract now describes the actual guarantee.** |
| #91 | `groupExists` used a hardwired runner on EPERM; permission uncertainty could be misinterpreted. | Explicit `ProcessInspection`, signal/identity/group channels and bounded validated fallback (`providers/process-inspection.ts:19,29,44`), consumed by stop (`child-supervisor.ts:67,210`). **Inspection seam fixed; whole-provider timing remains O/F4.** |
| #92 | Buffered output used undeclared wall clock; follow had a hidden wait fallback and cancellation could mask failures. | Required `recordingTime` (`adapters/target-effects.ts:31`), required CLI wait (`cli/types.ts:23`), entrypoint scheduling (`index.ts:29`), specific cancellation handling (`cli/rig.ts:73`). **Fixed.** |
| #101 | No explicit owned Preview-data cleanup contract in the old tree. | Preview-only destruction, persisted retry state, retirement before deletion, canonical ownership inspection, and failure-specific retained-inventory wording (`runtime/application.ts:361`; `adapters/preview-storage.ts:10`; `runtime/lifecycle.ts:118`). **New explicit effect owner and partial-progress channel.** |

## Remaining findings and ledgers

### F1 — Non-Status reply contracts still erase missing data into plausible empty output

**Consequence: correctness of user evidence and caller usability; medium priority.** `DaemonClient.command` validates only that the envelope owns a `result` property, then returns `unknown` (`src/daemon/client.ts:24,62`). `RigRuntime.command`, the HTTP handler and the CLI client retain that shape (`runtime/application.ts:33`, `daemon/server.ts:9`, `cli/types.ts:15`). `renderProjects`, logs, and Activity then substitute empty arrays for missing or wrongly typed fields (`cli/output.ts:29,95,114,125`). A response `{result: {}}` to list can consequently become “No Projects registered”; to logs, “No logs yet”; to Activity, “No activity yet.” This is a source-derived counterexample, not an observed live daemon response.

The first information-loss crossing is **`DaemonClient.command -> envelope.data.result` at `daemon/client.ts:70`**, which marks an envelope as sufficient without validating the action's result. The later loss is `rows(nonArray) -> []` at `cli/output.ts:125`. Status has already demonstrated a small vertical correction, so this need not become a giant generic RPC framework.

| Ledger | Evidence |
|---|---|
| Caller job / current call | CLI needs trustworthy data for the selected action: `client.command(correlated)` then `renderResult(request.action, result)` (`cli/rig.ts:39,45`). |
| Exact proposed contract | Per-action domain results and validation at transport intake, starting with inventory/log/Activity reads; valid empty collections remain valid. Return `DAEMON_PROTOCOL` for malformed success bodies. |
| Inputs / outputs | Request action and address capability; network effects, parsed reply or typed failure; presenter produces text from verified values. |
| Ambient / prerequisites | HTTP and deadline are intentional client-owned effects. Reply bytes remain untrusted even when the HTTP status is successful. |
| Failure / ownership | Transport owns syntactic/shape rejection; presenter owns rendering, not guessing absence. |
| Callees / trust | `request` is an O network adapter; Zod envelope validator is insufficient for these payloads; `rows` is inspected H code with lossy policy; Status validation has governing transport tests. |
| Verification to add | For list/logs/Activity, feed missing/null/wrong-type payloads through a local test transport and assert protocol failure plus nonzero CLI outcome; separately assert valid empty reports render their existing empty messages. Run transport, CLI, runtime-logs and activity-e2e tests. |

### F2 — Doctor compares one report against multiple config snapshots

**Consequence: local reasoning and report consistency; low-to-medium priority.** Doctor reads a Project document for identity (`src/runtime/doctor.ts:66`) and again for every Target (`:112`). The same report can validate identity from revision A, compare one Target with B and another with C. This is explicit provider I/O, **not hidden ambient access**, but the caller cannot interpret the resulting report as one current-config comparison. It also repeats acquisition/parse work without a new domain purpose. This carries forward tree B's U4.

| Ledger | Evidence |
|---|---|
| Caller job / call | Runtime needs one Project diagnostic report: `doctor(project, targets, deps)` (`runtime/application.ts:208`). |
| Inputs / outputs | Project, recorded Targets, document/Host/observation capabilities; materialized checks and ok flag. No runtime writes. |
| Ambient / prerequisites | Concrete document reads are external and replaceable. No revision stability is required of `documents.read`; read-only requests can overlap outside edits. |
| Failure | Missing/invalid config becomes findings; each acquisition can currently succeed or fail independently. |
| Callees / trust | `documents.read` has config integration tests; `documents.resolve` is the now-honest calculation; `isDeepStrictEqual` is deterministic; observations retain their separate bounded live-evidence contract. |
| Correction / conceptual level | Acquire a document result once; run identity and all drift comparisons against it. Preserve failure as one acquired result and preserve per-Target recovery checks. Live process observations need not pretend to be one atomic OS snapshot. |
| Verification to add | Supply a reader that returns different revisions on repeated calls and two Targets; assert one read and coherent comparisons against the first snapshot. Test one rejected read produces truthful Project/Target diagnostics. Run runtime-review-regressions and runtime-application/doctor coverage. |

### F3 — Retirement wrappers still drop initiating and recovery categories

**Consequence: diagnostic correctness/completeness; low-to-medium priority.** `retire` catches finalization failure and creates `RETIRE_COMMIT_PENDING` without the safe category of the caught error (`src/runtime/lifecycle.ts:117`); its rollback catch creates `RETIRE_ROLLBACK` while discarding both failures (`:131`). The finalization wording is now correct about retained versus removed inventory, including explicit destroy. This finding concerns lost causal evidence, not false inventory wording or an alleged unsafe rollback.

The first lossy edge is **`checkpoint.commit rejection -> new RigError(RETIRE_COMMIT_PENDING)` at `runtime/lifecycle.ts:116,119`**, or **`rollback/up rejection -> RETIRE_ROLLBACK` at `:129,132`**. Runtime's new diagnostic projection cannot recover evidence already discarded there. Deploy and registration now supply a direct, safe precedent; raw errors need not be exposed.

| Ledger | Evidence |
|---|---|
| Caller job / call | Destroy calls `lifecycle.retire(target)` before deleting bytes (`runtime/application.ts:381`); Preview replacement may pass `publishRemoval` (`runtime/application.ts:353`). |
| Inputs / outputs | Target, optional publication callback, captured effect capabilities; process/route/artifact/checkpoint writes; void success or phase-specific failure. Callback effects are inherited. |
| Ambient / prerequisites | No newly hidden OS source in `retire`; ownership and serialization are supplied by its callers/adapters. Retirement may partially publish. |
| Failure owner | Lifecycle correctly owns whether rollback is still allowed after publication. Its wrapper should also preserve bounded initiating/recovery categories. |
| Callees / trust | `stopForTransition` deliberately tolerates STOP_HOOKS only; checkpoint/route/artifact capabilities are effectful and partial; deployment-effects tests protect publication/commit/rollback behavior. New destroy test at `tests/runtime-application.test.ts:1622` protects retained-inventory wording. |
| Correction / verification | Keep phases and hints; attach `failureCauses(error)` and `failureCauses(error, recoveryError)` as appropriate. Inject classified commit and rollback failures, assert unchanged state behavior and categories in correlated diagnostics, and assert raw error contents remain absent. Run deployment-effects and runtime-application diagnostic/destruction coverage. |

### F4 — Child supervision's partial clock seam does not control stop or restart scheduling

**Consequence: testability and local reasoning; low priority.** `ChildSupervisorOptions.now` is an undocumented `() => Date` (`src/providers/child-supervisor.ts:48`). It controls captured timestamps and restart-window calculations (`:66,244`), but stop still reads `Date.now()` and sleeps (`:212–220`), and restart scheduling still uses `setTimeout` (`:250`). A caller supplying fixed `now` plus a fake `processInspection` has not supplied the entire timing behavior. This is an intentional OS adapter with **D at the overly broad implied clock seam**, not proof that the now-explicit permission inspection fix failed.

| Ledger | Evidence |
|---|---|
| Caller job / call | Lifecycle needs verified shutdown through `supervisor.stop(key)`; tests create a supervisor with fake group inspection. |
| Inputs / outputs | Receiver maps/options and key; identity/group/signal calls, elapsed waits, cancellation of restart state, drain/write completion, lease cleanup, stopped/unchanged or failure. |
| Ambient | First uninjected time read: `stop -> Date.now` at `:212`; blocking channel: `Bun.sleep` at `:215`; restart delay owner: `setTimeout` at `:250`. Live-child presence also still uses `process.kill` at `:149`, consistent with a concrete OS provider. |
| Prerequisites / failure | Successful stop requires owned group absence and output completion, not merely accepted SIGTERM. `now` currently proves neither expiration nor scheduler control. |
| Callees / trust | ProcessInspection's EPERM seam has explicit tests in `tests/providers-process-stop.test.ts`; live child/capture integration remains a different boundary. Platform timers are intentional but not controllable by `now`. |
| Correction / verification | At minimum document/rename the clock to its actual timestamp/restart-window role. If deterministic stop/backoff tests are needed, give this adapter a cohesive monotonic timing capability; do not pass it into runtime layers that never use it. Test escalation, cancellation, and late restart exclusion with controlled time; retain one real provider integration. |

## Remaining simplification opportunities, not additional correctness findings

1. **Exact capability promises.** `TargetEffectCheckpoint` (`runtime/lifecycle.ts:6`), `TargetLifecycle.retire` (`:63`), `Supervisor` (`providers/contracts.ts:19`), and `Router` (`providers/caddy-router.ts:16`) remain terse. Describe commit/rollback lifetime, retry rules, what shutdown preserves, what successful stop proves, callback partial progress, and which operations request cancellation. The new `RuntimeFiles.selectPorts` and `PreviewDeletion` contracts show the appropriate level of detail. Keep these at shared boundaries, not as ledgers throughout production code.
2. **Keep domain operations cohesive.** The runtime dispatcher and Target adapter are large, but length alone is not a defect. `execute` repeats production-branch acquisition and mixes request prerequisite checks with operation steps (`runtime/application.ts:197,238,281`). An operation-specific request/result boundary can hide that repeated policy while preserving one authority and one mutation queue. `persistTarget` already takes only `store`, and deploy intent is already named (`runtime/targets.ts:181`, `runtime/deploy.ts:22`); do not report these old suggestions as still unfixed.
3. **Absolute-path proof stops at the resolver API.** Persisted Project/Target paths remain plain nonempty strings (`runtime/state-schema.ts:43,44`); `selectProject` compares with `path.resolve` (`runtime/projects.ts:46`). Normal discovery supplies canonical absolute values. For schema-admitted restored relative records, `selectProject -> resolve(project.repoPath)` is still a conditional hidden cwd crossing and concrete lifecycle adapters can consume relative recorded paths without re-running the resolver. If making restoration contracts exact, validate at the state intake with an explicit legacy compatibility decision. Do not silently rewrite retained state or claim #87 fixed every path boundary.
4. **Admin subprocess seam.** `DaemonAdmin.launchctl -> Bun.spawn` (`daemon/admin.ts:299,300`) remains a deliberate admin effect owner but bypasses the common `CommandRunner` contract. Routing launchctl through a narrow provider would make launchd administration substitutable alongside process mode. No claim here that all raw spawn calls are illegal: command execution, supervision, and executable hooks are themselves expected process owners.
5. **Diagnostics fallback evidence.** `createHostDiagnosticLog.record` intentionally acquires Host policy lazily, but its failure callback falls back silently (`diagnostics/host-log.ts:14–17`). That fallback helps help/parser paths work and should stay nonfatal. A bounded policy-fallback category could explain the chosen defaults without leaking config or creating a second failure. This remains a known observability option, not a reason to treat the lazy adapter as hidden I/O.
6. **Optional defaults should be described where selected.** Composition selects some real runners implicitly through provider defaults (`daemon/composition.ts:63,64,97`) and lifecycle scheduling through its documented default (`:99`). Explicitly passing every runner is a readability option; creating redundant wrapper factories or a universal dependency bag solely to eliminate defaults would add little. The testable boundary is the relevant adapter/operation, not every primitive in every upstream function.

## Verification and coverage limits

This review inspected governing test code and assertions, but **did not execute tests**. Historical green counts in ticket notes are historical implementation evidence, not current results established by this audit. Suitable implementer follow-up sets are named with the findings; a real change must also meet the repository's build/typecheck/full-validation requirements in an isolated `RIG_ROOT`.

The strongest current source-level trust evidence is:

- `tests/runtime-status.test.ts:209,234,285,319,359`: safe rejection text, controlled common expiry, cleanup, queued settlement order and retained sibling evidence.
- `tests/activity-crashes.test.ts:126,169,197`: late outcomes, racing state changes, and explicit exclusion of store I/O from the observation budget.
- `tests/readiness-timing.test.ts:56,77,86,123,131,142,149,160`: uncooperative health, retries, checkpoint ownership, original rejection and deadline races through lifecycle.
- `tests/config.test.ts:491,505`: relative-root rejection and complete-plan cwd independence; `tests/project-discovery.test.ts:9,56,87,117`: fictional canonical paths and classified discovery failures.
- `tests/daemon-connection.test.ts:7,33,71`: fresh credentials, captured path and fallback matrix, remote failure handling; Status transport/CLI tests protect typed reports.
- `tests/providers-process-stop.test.ts:45,66,75,105,115,141,150`: EPERM fallback, malformed evidence, escalation, ESRCH and recovered identity changes.
- `tests/target-effects.test.ts:297`, `src/cli/cli.test.ts:396,634,659`, `tests/log-follow-entrypoint.test.ts:9`: per-entry recording time, opaque cursors, cancellation/failure precedence and compiled scheduler integration.
- `tests/deployment-effects.test.ts:197,216,382,456,473`, `tests/effect-preparation.test.ts:46,69,95,226`, `tests/runtime-application.test.ts:1313,1415,1487,1508,1622`, `tests/deployment-e2e.test.ts:116`: retained recovery authority, retirement phases, incomplete preparation and explicit destruction/retry channels.

| Area | Depth of this audit |
|---|---|
| CLI, daemon/remote entrypoints, runtime application/lifecycle/deploy | Traced consequential command branches, supplied dependencies, mutation/failure channels, direct effect boundaries, and selected governing tests. |
| Status, Activity, Doctor, registration, planning | Traced operation bodies and observation/timing/result crossings. Pure helper families inspected; not every input combination proved. |
| Transport and config editor | Traced host/server/client/connection and editor contract paths. Commander, Bun HTTP, YAML and Zod internals are trusted dependencies with integration tests, not audited implementations. |
| Process providers/capture | Traced stop/observation/identity/timing boundaries and inspected other provider branches. No live launchd, process-ownership, PID reuse, output-drain or scheduler-race proof. |
| Target effects, ownership, checkpoint preparation/transactions | Traced operation-facing calls, durable phase handling, log/environment effects and recovery boundaries; scanned supporting hash/file helpers. No complete filesystem race proof. |
| Config schema/resolver/documents | Traced resolver prerequisite, editing/publication and discovery boundaries; scanned schema and helper families. No exhaustive schema-field census. |
| Git source, artifact installer, Caddy, Host inspection, diagnostics | Inspected concrete ownership/effect entrypoints and selected helper bodies/contracts. No real tools, network or filesystem effects exercised. |
| Legacy migration | Scanned exported library operations, conversion/evidence and adoption-guard call boundaries. No new full compatibility or migration audit; source uncertainty and preserved data remain outside this review's proof. |

The appropriate claim is a stronger, more locally testable tree with specific remaining contract gaps. It is not that every effect has disappeared, every private helper has passed a ledger, or the current live deployment has been validated by this document.
