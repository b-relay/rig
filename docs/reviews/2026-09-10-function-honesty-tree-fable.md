# Rig function-honesty tree audit (Fable 5.1)

- Commit: `83496f8dafde3909a7a7121ef496aeae4dacd2ef` (main, after PR #113)
- Date: 2026-09-10
- Author: Claude Fable 5.1, working independently. The parallel Codex report was not opened while drafting.
- Process: the independent draft was followed by a source-verified factual QA pass; the corrections from that pass are folded in below and the independent conclusions are kept where the source supports them.
- Baselines: the two September 9 honesty-tree reports (A and B) are local, untracked artifacts, used only as a checklist. Every disposition below was re-verified against current source; no baseline finding was carried forward on trust.
- Method: read every module on the traced trees (see the coverage index in section 10), classified each function by the `function-design` skill's honesty test, and marked the first edge on each path where an honest contract calls something it does not declare. Test trust marks come from `grep` over `tests/*.ts` and the colocated `src/**/*.test.ts` files only. No tests were run, no production code was edited, no lifecycle commands were issued, and no live Rig state under `~/.rig` was touched.
- No whole-codebase honesty percentage is given. The roots below are the major user-facing trees, not a random sample.

## 1. Legend

Node classes:

| Mark | Meaning |
| --- | --- |
| `[H]` | Honest contract. The signature declares every behavior-affecting input, every observable output channel, and the failure vocabulary is tagged. |
| `[H~]` | Honest with a leak. Contract is declared, but a defaulted option, a doc-only failure policy, or one undeclared ambient read weakens it. The leak is named inline. |
| `[O]` | Effect owner by design. Entry point, composition root, adapter, or handler that is expected to touch ambient state. Dishonest by construction and acceptable as long as it stays thin. |
| `[D]` | Hidden dishonesty. A function positioned as a contract that reads ambient state, opens an undeclared channel, or swallows failure without saying so. |
| `[T]` | Transitive dishonesty. Honest signature, but the function cannot be honest because a callee it depends on is `[D]` or `[H~]` and the signature does not surface that. |

Edge marker `<-D` marks the first honest-to-dishonest edge on a path. Everything above such an edge is `[T]` unless the caller is itself `[O]`.

Callee trust marks: `t:<test file stems>` means at least one test file references the function by name; `t:-` means no test file names it (it may still be exercised through a parent). Colocated tests under `src/` are listed with their path.

Failure-policy vocabulary used below: `throws tagged` (RigError or ConfigError with code), `returns result` (failure is a value, e.g. `DiagnosticWriteResult`), `degrades` (failure is converted to an `unknown` or warning outcome and the function documents that), `swallows` (failure is dropped with no channel), `rethrows raw` (non-tagged error escapes).

## 2. Baseline disposition

Every row was checked against the current source at the cited lines.

| Baseline item | Current status | Evidence |
| --- | --- | --- |
| B U1: CLI client closure duplicated between `index.ts` and the remote helper | Resolved for `rig`; helper still builds its own per-command closure | `src/index.ts:47-62` `createCliClient(root, cwd)`; `src/git/remote-helper.ts:340-344` still reconnects inline |
| B T4: `CliDependencies.wait` optional with hidden timer fallback | Resolved | `src/cli/types.ts:23` `wait` is required; `src/index.ts:29` injects `waitForLogPoll` |
| B: `process.cwd()` read at several depths | Resolved | `src/index.ts:12` captures once; `src/cli/commands.ts:20` receives `cwd` |
| A3 / B realpath seam: project discovery called `realpath` and `runCommand` ad hoc | Resolved by #88 | `src/git/project.ts:32-39` `createProjectDiscovery(run)` owns `canonicalize: realpath` :35; `src/adapters/project-documents.ts:26` injects it |
| A1: an immediately rejecting observation was reported with the timeout reason | Resolved by #80; preserved in #83 | `src/runtime/status.ts:119-126` gives expired jobs "did not complete before the status deadline" and rejected jobs "Observation failed." |
| Connection acquisition and retry ownership | Shared acquisition in #86; no implicit probe or retry | `src/daemon/connection.ts:5-18` doc states "No probe or retry"; `DaemonClient` doc :32 "callers own retry policy" |
| A2: `resolveTargetPlan` consulted process cwd when `workspacePath`/`dataRoot` were relative | Resolved by #87 | `src/config/resolve.ts:71-78` throws `relative_root` before any path join, so cwd is no longer an input. This is a rejection of relative input, not a containment guarantee for the resolved paths |
| B T5: target log timestamps from ambient `Date` | Resolved by #92 | `src/adapters/target-effects.ts:32` `recordingTime` option; used :128 |
| B T2: process inspection EPERM handled inconsistently | Resolved by #91 | `src/providers/process-inspection.ts:42-59` |
| A4: readiness and observation timers not injectable | Resolved by #83/#84, defaults remain | `src/runtime/bounded-observations.ts:4-14`; `src/runtime/lifecycle.ts:68-87` |
| B T3: host diagnostic log silently falls back when host config is invalid | Persists | `src/diagnostics/host-log.ts:16` |
| B U3: detached-HEAD notice written from `prepareInteractiveRequest` | Persists | `src/cli/interaction.ts:139-142` |
| B O2: `/health` reveals `process.pid` | Persists, low | `src/daemon/server.ts:50-55` |
| B U2: hard-coded client timeouts | Persists | `src/daemon/client.ts:37,47,66` |
| A / B: `Promise<unknown>` command results | Persists at four seams | `src/runtime/application.ts:33`; `src/cli/types.ts:15`; `src/git/remote-helper.ts:22`; `src/daemon/host.ts:11` |
| B: monitor loop swallows failures | Persists | `src/daemon/composition.ts:145` |

## 3. Trees

### 3.1 `rig` CLI

```
src/index.ts main(args) [O] :10-45
  ambient: rigRoot() env :11, process.cwd() :12, SIGINT/SIGTERM :15-16, stdin/stderr isTTY :30, randomUUID :22, Date :26
├─ createCliClient(root, cwd) [H] :47-62                              t:daemon-connection
│  ├─ connectDaemon(root) [H] daemon/connection.ts:6-18                t:daemon-connection
│  │  ├─ readDaemonAddress(root) [H] daemon/files.ts:50-52 throws tagged DAEMON_STATE via readRecord :17-48
│  │  ├─ readDaemonToken(root) [H~] daemon/files.ts:57-71             t:-
│  │  │     leak: every read failure, including EACCES and corrupt content, becomes DAEMON_MISSING :64-70
│  │  └─ new DaemonClient(address) [O adapter] daemon/client.ts:33     t:transport, runtime-application
│  │        global fetch :79, AbortSignal.timeout :86, fixed deadlines 1500/5000/300000 :37,47,66
│  │        replies parsed with zod :36,43,51,62; failure: throws tagged DAEMON_UNREACHABLE / DAEMON_PROTOCOL / daemon error code
│  └─ inspectOfflineHost(root, cwd) [H] daemon/offline-doctor.ts:12-50 t:-
│     ├─ inspectHost(root) [H~] adapters/host-inspection.ts:7-86 <-D   t:runtime-review-regressions, runtime-application
│     │     leak: Bun.which :43 reads ambient PATH; access() :61,69 (acceptable for a doctor, undeclared)
│     └─ discoverProject(cwd) [O adapter] config/documents.ts:177-199 realpath/stat directly
├─ createHostDiagnosticLog({root, source, now}) [H~] diagnostics/host-log.ts:8-21   t:-
│     leak: readHostConfig rejection falls back to defaults with no channel :16 (B T3)
│  └─ createFileDiagnosticLog(options) [O adapter] diagnostics/file-log.ts:80-129    t:src/diagnostics/file-log.test.ts, runtime-application
│        returns result { path | error } :119; sqlite lock with setTimeout retry :132-158; rotate :159-188; prune :219-238
├─ waitForLogPoll(ms, signal) [O timer owner] adapters/log-follow-scheduler.ts:2-13   t:src/cli/cli.test.ts
├─ createTerminalInteraction(stdin, stderr, signal) [O adapter] adapters/terminal-interaction.ts (not traced)
└─ runRigCli(args, deps: CliDependencies) [H] cli/rig.ts:10-85         t:src/cli/cli.test.ts, runtime-logs, transport, target-effects
   ├─ requestsStructuredOutput(args) [H pure] :106-114
   ├─ createRigCommand(cwd, output, execute) [H] cli/commands.ts:19-87  t:- (covered through runRigCli)
   │     pure grammar; failure: throws tagged USAGE :128,221,299-340,387-403; commander errors mapped in reportFailure
   ├─ prepareInteractiveRequest(request, deps) [H] cli/interaction.ts:25-147   t:src/cli/interaction.test.ts, transport, runtime-application
   │     declared channels: deps.client.status/command, deps.interaction, deps.output.error :139-142 (B U3), deps.signal
   │     replies re-validated with local zod schemas :14-23 via readReply :156-165; failure: throws tagged DAEMON_PROTOCOL, CANCELLED, TARGET_REQUIRED, PRODUCTION_CONFIRMATION
   ├─ recordDiagnostic(log, entry) [H] cli/failure.ts:33-42 returns result; never throws
   ├─ deps.client.status(correlated) / deps.client.command(correlated) :35-39  result: unknown
   ├─ renderStatus / renderResult / renderLogs [H pure] cli/output.ts:3-119; control chars stripped :129-136
   ├─ followLogs(request, initial, deps) [H] cli/rig.ts:88-104 uses deps.wait :95; opaque cursor :93,102
   └─ reportFailure(error, input) [H] cli/failure.ts:51-88 expected-code allowlist :10-30; provider details never rendered
```

First dishonest edges inside the honest subtree: `inspectOfflineHost -> inspectHost` (ambient PATH), `createHostDiagnosticLog` (silent fallback), and `DaemonClient.request` (fixed deadlines, global fetch). `main` is the intended effect owner and is thin: every ambient read is acquired once and passed down.

### 3.2 `rigd` entry, composition, host, control plane

```
src/rigd.ts main(args) [O] :10-37
  ambient: rigRoot :11, RIG_DAEMON_CHILD :16, RIG_ROOT selects mode :26, homedir :27, randomUUID :30, Date :34
├─ runCapturedProcess(requestPath) [O] providers/captured-process.ts:19-80      t:providers-capture, providers-process, providers-launchd*
│     createChildSupervisor({ stateRoot }) with defaults :23 (see 3.8); signals :28-30; process.pid :33; Date.now :48; Bun.sleep(50) :64
├─ composeDaemon(root, captureCommand) [O composition root] daemon/composition.ts:31-159
│  ├─ readHostConfig(root) [H] config/documents.ts:201-206
│  ├─ createFileDiagnosticLog({root, source, now, ...host.diagnostics}) [O adapter] :36-41
│  ├─ createChildSupervisor({ stateRoot, captureCommand }) [H~] providers/child-supervisor.ts:56 <-D   t:providers-process, providers-process-stop, runtime-lifecycle
│  │     leak: now defaults to Date :66, inspection defaults to createProcessInspection() :67, which itself defaults run/kill :32-35
│  ├─ createLaunchdSupervisor({ root, domain, labelPrefix, captureCommand }) [H~] providers/launchd-supervisor.ts:31 <-D   t:providers-launchd, providers-launchd-observation
│  │     leak: run/identity/inspection default :32-34; fixed Bun.sleep(100) loops :91,184
│  ├─ process.getuid() ?? 501 :45, process.env :55 (owner reads, passed down as values)
│  ├─ createTargetEffects({ recordingTime, root, supervisors, run, installer, router, environment }) [H~] adapters/target-effects.ts:57 <-D   t:target-effects, deployment-effects
│  │     leak: health uses global fetch :150; prepare embeds package-manager selection :291-304
│  │  ├─ createArtifactInstaller() [H~] providers/artifact-installer.ts:29  run defaults :35; Bun.which("bun") :66   t:providers-installer, deployment-effects, target-effects
│  │  └─ createCaddyRouter({ caddyfile, reload, extraConfig, reloadCommand? }) [H~] providers/caddy-router.ts:23  run defaults :31   t:providers-caddy, effect-preparation, deployment-effects
│  ├─ new FileStateStore(root) [O adapter] runtime/state-store.ts:15-83  update queue with .next + rename :64-82; throws tagged LEGACY_STATE_PRESENT :39, STATE_READ :47, STATE_CORRUPT :55   t:state
│  ├─ createAdminActivityJournal({ root, now, id }) [H] adapters/admin-activity.ts:52-121  append failure degrades to warning :108-112   t:activity-admin
│  ├─ createRuntime(deps: RuntimeDependencies) [H] runtime/application.ts:49   t:7 files
│  │  ├─ inspectHost(root) [H~] (as above)
│  │  ├─ createAdoptionGuard(root) [H] migration/adoption.ts:192-202 throws tagged LEGACY_ADOPTION_PENDING :196   t:migration*, migration-runtime-e2e
│  │  ├─ createProjectDocuments(root, runCommand) [H] adapters/project-documents.ts:22-85   t:initialization-slug, project-registration
│  │  │  └─ createProjectDiscovery(run) [H~] git/project.ts:32-39 <-D   t:git-project
│  │  │        leak: reads process.env :33 inside the factory; forces LC_ALL=C :37 (good), canonicalize: realpath :35 (declared in ProjectDiscovery :26-29)
│  │  ├─ createDeploymentSources(createGitSourceStore({ root }), runCommand) [H] adapters/deployment-sources.ts:6-57   t:-
│  │  │  └─ createGitSourceStore({ root }) [H~] providers/git-source-store.ts:20  run defaults :24   t:providers-git, migration-runtime-e2e
│  │  ├─ createTargetLifecycle(effects) [H~] runtime/lifecycle.ts:84-87  timing defaults to setTimeout owner :76-81   t:runtime-lifecycle, readiness-timing, deployment-effects
│  │  └─ createRuntimeFiles() [O adapter] adapters/runtime-files.ts:7-31  binds 127.0.0.1 sockets :32-50; throws tagged PORT_RESERVED :17   t:port-selection (through selectPorts)
│  ├─ createConfigEditor({ resolveProject, documents, exclusive }) [H] daemon/config-editor.ts:156-248   t:config-control-plane
│  ├─ start(): reconcile :132 then setInterval 5000 :134-149
│  │     monitorRuntimeFailures({ store, observations, now }) :139-143 with no deadline -> default timer (runtime/activity.ts:37-38)
│  │     .catch(() => {}) :145 swallows monitor failure with no channel
│  └─ shutdown(): drain, child.shutdown, launchd.shutdown :151-157
├─ runDaemonHost({ root, port, handle, shutdown, start?, editor? }) [O] daemon/host.ts:17-124   t:daemon-admin, activity-admin
│     process.pid + randomUUID :31; SIGTERM/SIGINT :115-116; process.exitCode :108,111; processExists :125-132 uses process.kill
│  ├─ readDaemonToken(root) [H~] :80 (as above)
│  └─ startControlPlane({ port, token, instanceId, handle, editor? }) [O] daemon/server.ts:20-137   t:transport, git-push, log-follow-entrypoint, runtime-application
│        Bun.serve 127.0.0.1 :23-26; timing-safe bearer check :13-17; origin check :39-49; /health returns process.pid :53
│        commandSchema.parse (strict) :95; failure: 400/401/403/404/422/500 JSON with tagged codes; provider details never serialized :112-121
└─ runRigdCli(args, { admin, output, diagnostics, newOperationId }) [H] cli/rigd.ts:14-67   t:src/cli/rigd.test.ts
   └─ new DaemonAdmin({ root, command, mode, userHome }) [O adapter] daemon/admin.ts:48-330   t:daemon-admin, activity-admin
         constructor defaults journal clock/id :53-59; DaemonClient.health for reachability :61-95
         performInstall :136-178 polls 100 x 50 ms :168-172; performUninstall :179-251 uses process.kill :227 and compensates with cancel-uninstall :238
         spawnDetached reads process.env :269; labelDomain uses getuid ?? 501 :289; launchctl via Bun.spawn :300; installLaunchd reads PATH :321
```

First dishonest edges: every provider factory that defaults its runner, clock, or sleeper. The composition root passes `runCommand` explicitly to `createTargetEffects`, `createProjectDocuments` and `createDeploymentSources` :63,94,97 but not to `createGitSourceStore`, `createArtifactInstaller`, `createCaddyRouter`, `createChildSupervisor` or `createLaunchdSupervisor`. The honesty boundary therefore sits inside those five factories rather than at the composition root. Adapters may own such defaults under `function-design`; the inconsistency with the three injected siblings is what makes it worth moving (see 6).

### 3.3 `git-remote-rig`

```
src/git/remote-helper.ts main(args) [O] :310-351
  ambient: userOutput :311, process.cwd :325, runCommand :326,334, rigRoot :328, process.stdin :331, randomUUID :333, Date :338
├─ inspectProjectGit(cwd, discovery) [H] git/project.ts:169-184  throws tagged GIT_*   t:git-project
├─ createGitPushSource(repoPath, run) [H] :264-307  throws tagged GIT_REF / GIT_BRANCH   t:git-push
├─ createHostDiagnosticLog(...) [H~] (3.1)
├─ client: { command } built inline; connectDaemon(root) per command :340-344 (address and token re-read on every push and list)
└─ runRemoteHelper(url, dependencies) [H] :66-227   t:git-remote-helper, daemon-connection
      channels: output.write carries protocol frames only :85,116,186,198,206; output.error carries human text :74,182,201,224
      client.command(): Promise<unknown> :22, re-validated with local zod schemas: status :40-53, completed :54-60
      failure: returns exit code, never throws past :222-226; per-push failure emits "error <dest>" :198 and evidence via diagnostic() :256-263
   ├─ projectFromRemote / parsePush / oneLine [H pure] :228-255
   ├─ targetName(input) [H pure] runtime/targets.ts:13-39
   └─ recordDiagnostic [H] cli/failure.ts:33-42
```

`runRemoteHelper` is fully honest: Git's stdout protocol and the human stderr channel are both declared through `UserOutput`, replies are untrusted and parsed, and the exit code is the only failure channel. The leak is structural: the local `status` schema :40-53 duplicates `projectStatusSchema` in `src/domain/project-status.ts:3-92` rather than taking a `ProjectStatusReader` like `CliDependencies.client` does (`src/cli/types.ts:14`). One difference must survive any reuse: the helper's schema validates `commit` with `isGitCommit` (:36-39, :49) while the shared schema types `commit` as a plain string (`src/domain/project-status.ts:70`), and the helper acknowledges pushes by exact commit.

### 3.4 Runtime command dispatch

```
createRuntime(deps: RuntimeDependencies) [H] runtime/application.ts:49
  RuntimeDependencies runtime/contracts.ts:89-120 declares root, store, documents, sources, lifecycle, observations, files, now, id, diagnostic, inspectHost, assertOwnershipReady, readAdminActivity
├─ command(command): Promise<unknown> [H, weak result type] :525-530 -> serial queue -> execute
├─ execute(command) [H] :65-502
│     read-only actions bypass exclusivity via `reads` :38-47; draining and prepare-uninstall gate :73-104
│     list: ownership check try/catch :107-112 degrades to a flag
│     deployment-context: GIT_DETACHED swallowed into currentBranch: null :184-191 (consumed by interaction.ts:139)
│     git-push target derivation :215-235
│  ├─ selectProject(command, deps, readConfig = true) [H] runtime/projects.ts:8-55  throws tagged PROJECT_*   t:- (through runtime-application)
│  ├─ registerProject [H] :56-113 REGISTRATION_INCOMPLETE :104-110   t:project-registration
│  ├─ updateRegistration [H] runtime/registration.ts:7-127 RENAME_ROLLBACK :65   t:-
│  ├─ projectStatus(project, targets, command, deps: Pick<...>) [H] runtime/project-status.ts:16-23   t:-
│  │     ownership failure degrades to unknown components :30-51
│  │  └─ observeTargets(targets, effects, budgetMs = 2000, deadline = timerObservationDeadline) [H~ defaulted timer] runtime/status.ts:38-43   t:runtime-status, providers-launchd-observation
│  │     └─ boundedObservations(jobs, budgetMs, deadline) [H] runtime/bounded-observations.ts:24-73; expired/rejected degrade to unknown status.ts:119-126   t:- (tests use controlled-observation-deadline.ts through observeTargets)
│  ├─ deploy :274-360
│  │  ├─ deps.sources.resolve / preflightDeployment(input, run) [H] git/preflight.ts:6-100  throws tagged GIT_LOCAL_BRANCH / GIT_COMMIT / GIT_UPSTREAM; degrades stale upstream to warning :74-80   t:git-preflight, git-project
│  │  ├─ planTarget(input, deps) [H] runtime/targets.ts:40-180  deps.id :63,90; deps.files.selectPorts :159-163; deps.documents.resolve :165; deps.now :175-176   t:-
│  │  ├─ activateDeployment(candidate, target, { activation }, deps) [H] runtime/deploy.ts:18-133 (3.6)   t:deployment-effects
│  │  ├─ persistTarget(target, store: Pick<StateStore, "update">) [H] runtime/targets.ts:181-190   t:-
│  │  └─ lifecycle.retire(previous) :352-358
│  ├─ destroy :361-391 (#101)
│  │  ├─ inspectPreviewDeletion(root, target) [H] adapters/preview-storage.ts:23-26 -> inspectDeletionRoot :42-110   t:runtime-application
│  │  ├─ store.update marks destructionPending :375-378 before any irreversible step
│  │  ├─ lifecycle.retire :381
│  │  ├─ destroyPreview(...) [H] adapters/preview-storage.ts:10-22 throws tagged DESTROY_CLEANUP :16   t:runtime-application
│  │  └─ store.update filter :387-389
│  ├─ up / down / restart -> lifecycle.up / lifecycle.down; stopRecordedTarget(target, lifecycle) [H] runtime/stop.ts:7-21
│  ├─ logs -> readTargetLogs(target, after, lines) [O adapter] adapters/target-log-reader.ts:58-134   t:- (runtime-logs covers through createRuntime)
│  ├─ doctor(...) [H~] runtime/doctor.ts:59-186   t:-
│  │     leak: every read/resolve failure becomes reason "config-invalid" :83-91,141-149, including I/O and permission errors
│  ├─ catch: records failure with diagnosticErrorCode / diagnosticCauses :433-454; a failure inside that recording is swallowed :437-451
│  └─ record(...) :455-485 -> deps.store.update; deps.diagnostic failure swallowed :482-484
├─ exclusive(fn) [H] :509-524
├─ drain() [H]
└─ reconcile() [H] :531-573  diagnostic `.catch(() => {})` :547,567
```

`RigRuntime.command` returning `Promise<unknown>` (:33) is the one honesty gap on the contract itself. Every other dependency is declared in `RuntimeDependencies`. Inside, exceptions thrown by `deps.diagnostic` are caught and dropped in three places (:437-451, :482-484, :547/:567), which is a policy, but it is not stated on `RuntimeDependencies.diagnostic`. The returned `{ error }` value is a separate loss: the composition closure discards it (`composition.ts:104-110`). Both differ from the CLI, where `recordDiagnostic` returns the failure and `runRigCli` prints it (`cli/rig.ts:54`).

### 3.5 Lifecycle

```
createTargetLifecycle(effects: TargetEffects, timing = readinessTiming) [H~] runtime/lifecycle.ts:84-87   t:runtime-lifecycle, readiness-timing
  TargetEffects :11-46 and TargetLifecycle :47-67 are declared interfaces; ReadinessTiming :68-73; default readinessTiming owns setTimeout :76-81
├─ up(target) :141-225  checkpoint -> prepare :155 -> per component: install (installed kind) or observe / preStart hooks / ensureRunning / awaitReady / postStart :157-195 -> route :196 -> Target postStart :197-198 -> commit :199; START_ROLLBACK_FAILED :217. Routes are published only after readiness.
│  └─ awaitReady :299-340  polls effects.health with timing.schedule at 100 ms :325; failure: throws tagged
├─ down(target) :226-295  STOP_INCOMPLETE :277, STOP_HOOKS :284
├─ retire(target) :106-140  RETIRE_COMMIT_PENDING :119, RETIRE_ROLLBACK :132
├─ stopForTransition :342-352
└─ assertProviderProfile :353-361
```

Honest. The only leak is the defaulted timer. The default `readinessTiming` is a named module constant (:76-81) but it is not exported; tests substitute it through the constructor argument (`tests/readiness-timing.test.ts`), not by importing the default.

### 3.6 Deploy and recovery

```
activateDeployment(candidate, previous, intent: { activation }, deps) [H] runtime/deploy.ts:18-133   t:deployment-effects
├─ assertDeploymentRecovered :7-16
├─ deps.lifecycle.up / stopForTransition
├─ failure: throws tagged DEPLOY_COMMIT_PENDING :69, DEPLOY_ROLLBACK_BLOCKED :96, DEPLOY_RESTORE_FAILED :115
│     retainFailureCauses :42,93,112,128 preserves the closed FailureCauses vocabulary (domain/errors.ts:48-81)
└─ stopForRecovery :135-161

createEffectTransactions({ root, ownership, router }) [H] adapters/effect-transactions.ts:69-332   t:effect-preparation
├─ load :87-105; rollback :116-179
├─ checkpoint :181-255  EFFECTS_RECOVERY :190, ARTIFACT_CONFLICT :198; removeCheckpoint failure swallowed :249-251
├─ captureArtifact :256-270  EFFECTS_SCOPE :263
├─ commit :278-313  removeCheckpoint failure swallowed :310-312 (prior committed journal tolerated on next load :186-187)
└─ restore :314-330

createEffectPreparation(root, directory) [H] adapters/effect-preparation.ts:41-157   t:- by name
├─ validateLayout :53-74; begin :95-119; recover :120-151 EFFECTS_PREPARATION_PRESERVED :142; release :152-155

createArtifactOwnership(root) [H] adapters/artifact-ownership.ts:30-107   t:effect-preparation
   ARTIFACT_CONFLICT :62, ARTIFACT_UNOWNED :69, ARTIFACT_CHANGED :76; publish :87-105; atomicFile :171-184

Preview destruction (#101) adapters/preview-storage.ts
├─ inspectDeletionRoot :42-110  identity and scope :55-71; realpath + device check :74-85; protected-path overlap :92-106; verifyTree :108,172-185
└─ destroyPreview :10-22  DESTROY_CLEANUP :16

Legacy adoption migration/adoption.ts
├─ readLegacyAdoption(root) :136-190; createAdoptionGuard(root) :192-202; validateEvidence :203-260; finalizeLegacyAdoption :262-345   t:migration, migration-adoption, migration-runtime-e2e
```

All honest. The two swallowed `removeCheckpoint` failures are a deliberate "leave the journal, tolerate it later" policy, but nothing on the interface says so and no test name references it (see 8).

### 3.7 Status and monitoring

```
projectStatus [H] -> observeTargets [H~] -> boundedObservations [H] (3.4)
monitorRuntimeFailures({ store, observations, now, budgetMs?, deadline? }) [H~] runtime/activity.ts:20-102   t:activity-crashes
   defaults budgetMs 2000 and deadline timerObservationDeadline :37-38; crash id sha256 :50-61
   caller composition.ts:139-143 passes no deadline, so production always uses the timer owner
effects.observations(target) adapters/target-effects.ts:436-482
   artifact inspection catch-all degrades to "unknown" :477-479; persistent = exists :481
```

### 3.8 Providers

```
createChildSupervisor(options: ChildSupervisorOptions) [H~] providers/child-supervisor.ts:56-396   t:providers-process, providers-process-stop, runtime-lifecycle
   options :45-54; now defaults Date :66; inspection defaults createProcessInspection() :67
├─ recover :88-117
├─ observe :118-176  process.kill(owned.pid, 0) directly :149  <-D  (bypasses ProcessInspection, whose contract is identity / groupExists / signalGroup :18-22; `kill` is a factory option, not an interface method, and groupExists probes a group, not one pid)
├─ stop :177-234  Date.now :212,218 and Bun.sleep(20) :215,220 directly; deadlines 4000/1500 :213  <-D  (the `now` option covers only restart windows and log timestamps)
├─ scheduleRestart :235-268  setTimeout :250, backoff :264
├─ ensureRunning :269-380  detached spawn :310-315
└─ captureOutput :397-448

createProcessInspection(options = {}) [H~] providers/process-inspection.ts:29-80   t:providers-process-stop
   run ?? runCommand :32; kill ?? process.kill :33-35; ps -g with 2000 ms :43-46; PROCESS_INSPECT :53; signalGroup :61-78
createProcessIdentityReader(run = runCommand) [H~] providers/process-identity.ts:9-32   t:providers-launchd-observation
runCommand(request) [O adapter] providers/command-runner.ts:5-75   t:8 files
   detached spawn :20-25; SIGKILL group on abort :33; COMMAND_START :54; COMMAND_TIMEOUT :67; 1 MiB caps :46,49

createLaunchdSupervisor(options) [H~] providers/launchd-supervisor.ts:31-197   t:providers-launchd, providers-launchd-observation
   run/identity/inspection default :32-34; observe :49-86; waitForApplication 30 x Bun.sleep(100) :87-99  <-D; stop :155-192 Bun.sleep(100) :184
   LAUNCHD_FAILED details carry raw stderr :45

Capture chain
├─ runCapturedProcess(requestPath) [O] providers/captured-process.ts:19-80 (3.2)
├─ writeCaptureObservation :32-44; readCaptureObservation({ requestPath, wrapperPid, inspect, now, signal }) [H] providers/capture-observation.ts:47-79  age > 1000 ms degrades to unknown :74   t:-
└─ waitForCaptureStart(requestPath, timeoutMs = 5000) [O timer] providers/capture-status.ts:35-64  Date.now / Bun.sleep directly

createGitSourceStore({ root, run? }) [H~] providers/git-source-store.ts:20-121  run defaults :24; GIT_FAILED details carry raw stderr :33; per-project queue :108-120
createArtifactInstaller(options = {}) [H~] providers/artifact-installer.ts:29-103  run defaults :35; Bun.which("bun") :66
createCaddyRouter(options) [H~] providers/caddy-router.ts:23-176  run defaults :31; change :33-151 validate -> backup -> rename -> reload -> rollback; ROUTE_VALIDATE :113 / ROUTE_RELOAD :135 details carry raw stderr; checkpoint :160-167; restore :168-174
createRuntimeFiles() [O adapter] adapters/runtime-files.ts:7-31  selectPorts({ requests, occupied, policy }) :11-28; availablePort binds 127.0.0.1 :32-50
```

### 3.9 Config

```
discoverProject(cwd) [O adapter] config/documents.ts:177-199  realpath/stat directly
├─ locateConfig :31-64  ambiguous_config :57
└─ readProjectConfig :163-175
readHostConfig(root) [H] :201-206
initializeProjectConfig :208-223  writes with flag "wx"
editProjectConfig :286-347 [H]  lock "wx" :293; backup :309; randomUUID tmp name :322 (only ambient call in the module); revision re-check :327-335   t:config, config-control-plane
resolveTargetPlan(input: ResolveTargetPlanInput) [H pure] config/resolve.ts:70-168   t:config, runtime-review-regressions, runtime-application
   interpolate :22-35 unknown_interpolation; relative_root :71-78 (#87); missing_port :194; port_collision :200; invalid_binding :338 (#100 interpolated bind ports accepted)
createConfigEditor(deps: ConfigEditorDependencies) [H] daemon/config-editor.ts:156-248   t:config-control-plane
   request schema :51-74; read and preview run outside `exclusive`, apply runs inside :244-246 (correct: only apply mutates)
```

`src/config/schema.ts` and `src/config/editor.ts` were grepped for ambient calls (none) but not traced field-by-field.

### 3.10 Logs

```
createFileDiagnosticLog(options) [O adapter] diagnostics/file-log.ts:80-129   t:src/diagnostics/file-log.test.ts
   diagnosticRecord :34-63 with closed metadata keys :23-30; safeMetadata :64-69; returns { path } | { error } :119 (never throws to callers)
   acquireLock via sqlite :132-158 with setTimeout retry :151; rotateDiagnostic :159-188; pruneDiagnostics :219-238
createHostDiagnosticLog [H~] (3.1)
readTargetLogs(target, after, lines) [O adapter] adapters/target-log-reader.ts:58-134
   decodeCursor :135-154; readSource :156-214 with 4 MiB window :9; LOG_CORRUPT :248
createAdminActivityJournal [H] (3.2)
```

The diagnostic write contract (`DiagnosticLog.record(entry): Promise<DiagnosticWriteResult>`, `diagnostics/types.ts:17-20`) is the cleanest failure-as-value boundary in the codebase. It is honoured at the CLI (`cli/rig.ts:47-54`, `cli/rigd.ts:44-49`, `remote-helper.ts:256-263`) but not on the daemon side. The composition closure (`composition.ts:104-110`) awaits `record` and discards its returned `{ error }`, so a lost write is invisible to the runtime. Separately, the runtime swallows exceptions thrown by its diagnostic dependency at the sites listed in 3.4. These are two different losses: a returned failure that nobody reads, and a thrown failure that is caught and dropped.

## 4. Ledgers for consequential boundaries

Format: inputs / outputs and channels / ambient / prerequisites / failure policy / direct callees with trust.

### 4.1 `createRuntime(deps)` — `src/runtime/application.ts:49`
- Inputs: `RuntimeDependencies` (`contracts.ts:89-120`), all explicit.
- Outputs: `{ command, exclusive, reconcile, drain }`; `command` resolves `unknown` (:33).
- Ambient: none in the module. All time, ids, I/O and process effects arrive through `deps`.
- Prerequisites: `deps.assertOwnershipReady` is called before mutating actions. The host listens and publishes its address (`host.ts:78-91`) before `start` is invoked (`host.ts:117-120`); listening is daemon readiness by design, and reconciliation is queued ahead of later commands only because `start` is invoked synchronously and the runtime serializes mutations.
- Failure: throws tagged `RigError`/`ConfigError`; converts to `OperationRecord` with `diagnosticErrorCode` and `diagnosticCauses` (`domain/errors.ts:129-159`); exceptions thrown by `deps.diagnostic` are caught and dropped (:437-451, :482-484, :547, :567); the returned `{ error }` is discarded upstream by the composition closure.
- Callees: `selectProject` t:-, `registerProject` t:project-registration, `planTarget` t:-, `activateDeployment` t:deployment-effects, `persistTarget` t:-, `projectStatus` t:-, `doctor` t:-, `inspectPreviewDeletion`/`destroyPreview` t:runtime-application, `readTargetLogs` t:-, `stopRecordedTarget` t:-.

### 4.2 `activateDeployment(candidate, previous, intent, deps)` — `src/runtime/deploy.ts:18`
- Inputs: candidate and previous `TargetRecord`, `{ activation: "prepare" | "start" }`, `deps` (lifecycle + store).
- Outputs: the activated record; side effects only through `deps.lifecycle` and `deps.store`.
- Ambient: none.
- Prerequisites: `assertDeploymentRecovered` :7-16 refuses to proceed when the previous record has `recovery` pending (:24 passes `previous`, not the candidate).
- Failure: throws tagged `DEPLOY_COMMIT_PENDING`, `DEPLOY_ROLLBACK_BLOCKED`, `DEPLOY_RESTORE_FAILED`; `retainFailureCauses` keeps only closed causes; nothing swallowed.
- Callees: `deps.lifecycle.up/stopForTransition` (3.5) t:runtime-lifecycle; `stopForRecovery` :135-161 t:deployment-effects.

### 4.3 `createTargetLifecycle(effects, timing)` — `src/runtime/lifecycle.ts:84`
- Inputs: `TargetEffects` :11-46, `ReadinessTiming` :68-73 (defaulted to a named timer owner :76-81).
- Outputs: `TargetLifecycle` :47-67.
- Ambient: none once `timing` is passed. Default is `setTimeout`.
- Prerequisites: `assertProviderProfile` :353-361 before any supervisor call.
- Failure: throws tagged `START_ROLLBACK_FAILED`, `STOP_INCOMPLETE`, `STOP_HOOKS`, `RETIRE_COMMIT_PENDING`, `RETIRE_ROLLBACK`; compensations are explicit in `up`/`retire`.
- Callees: `effects.*` (3.8 adapter) t:target-effects; `timing.schedule` t:readiness-timing.

### 4.4 `createTargetEffects(options)` — `src/adapters/target-effects.ts:57`
- Inputs: `TargetAdapterOptions` :29-38 (`recordingTime`, `root`, `supervisors`, `run`, `installer`, `router`, `environment`).
- Outputs: `TargetEffects`; writes target logs and preparation markers under `root`; reads configured env files (:86-97, :495-530) and merges them with the injected environment.
- Ambient: global `fetch` :150 (undeclared); package-manager lockfile policy :291-304 (undeclared policy); fixed timeouts 120000 :98-115, 2000 :162, 600000 :311.
- Prerequisites: `prepare` marker :282-286, :320-321 gates re-preparation.
- Failure: throws tagged; `health` rethrows abort :166; `observations` artifact errors degrade to `unknown` :477-479.
- Callees: `options.run` t:8 files, `options.installer` t:providers-installer, `options.router` t:providers-caddy, `options.supervisors.*` t:providers-process/launchd.

### 4.5 `createChildSupervisor(options)` — `src/providers/child-supervisor.ts:56`
- Inputs: `ChildSupervisorOptions` :45-54 (`stateRoot`, `captureCommand?`, `now?`, `inspection?`).
- Outputs: `Supervisor` (`providers/contracts.ts:18-25`); spawns detached processes; writes capture requests.
- Ambient: `process.kill` :149, `Date.now` :212/:218, `Bun.sleep` :215/:220, `setTimeout` :250, plus defaults :66-67. The signature suggests `now` and `inspection` cover time and process probing; they do not cover `observe` and `stop`.
- Prerequisites: capture request file exists before `observe` reports running (`readCaptureObservation` :74 freshness).
- Failure: throws tagged; restart backoff is internal state.
- Callees: `createProcessInspection` t:providers-process-stop, `readCaptureObservation` t:-, `waitForCaptureStart` t:-, `runCommand` (through inspection default).

### 4.6 `DaemonClient` — `src/daemon/client.ts:33`
- Inputs: `DaemonAddress { port, token }`.
- Outputs: typed `DaemonHealth`, `ProjectStatusReport`, or `unknown` for `command`.
- Ambient: global `fetch` :79, `AbortSignal.timeout` :86, fixed deadlines :37/:47/:66.
- Prerequisites: caller acquired address and token via `connectDaemon`.
- Failure: throws tagged `DAEMON_UNREACHABLE` for any transport error :89-95 (including timeout, which is then indistinguishable from refusal), `DAEMON_PROTOCOL` for unparseable replies, or the daemon's own code :105-109. No retry (declared :32).
- Callees: none in-repo.

### 4.7 `createFileDiagnosticLog(options)` — `src/diagnostics/file-log.ts:80`
- Inputs: `root`, `source`, `now`, host diagnostics policy.
- Outputs: `DiagnosticLog.record -> { path } | { error }`.
- Ambient: sqlite lock file, `setTimeout` retry :151, filesystem rotate/prune.
- Prerequisites: none; creates directories.
- Failure: returns result; never throws to the caller :119. Metadata keys are a closed list :23-30 so provider `details` cannot leak into the log.
- Callees: none outside node/bun.

### 4.8 `runRemoteHelper(url, dependencies)` — `src/git/remote-helper.ts:66`
- Inputs: `RemoteHelperDependencies` :18-29 (`repoPath`, `input`, `output`, `client`, `source`, `newOperationId`, `diagnostics?`).
- Outputs: exit code; stdout frames and stderr text through `output`.
- Ambient: none.
- Prerequisites: `client.command` must return the daemon's `status` and `git-push` shapes; re-validated locally :89, :163.
- Failure: returns 1; per-push failure is a frame plus diagnostic; protocol misuse is `GIT_PROTOCOL`.
- Callees: `targetName` t:-, `recordDiagnostic` t:-, `dependencies.*` injected (t:git-remote-helper, git-push).

### 4.9 Preview destruction path — `src/runtime/application.ts:361-391`
- Inputs: `destroy` command with a preview target.
- Outputs: target removed from state; deletion of the verified preview root; `destructionPending: true` persisted first :375-378 (`domain/runtime.ts:26`).
- Ambient: none in the runtime; `inspectDeletionRoot` reads `realpath` and device ids :74-85 as a declared adapter.
- Prerequisites: `inspectPreviewDeletion` passes identity, scope, device and protected-path checks before `retire` runs.
- Failure: throws tagged `DESTROY_CLEANUP` after retirement; a partially deleted tree stays recorded with `destructionPending`. `reconcile` explicitly skips such targets (`application.ts:553`), so cleanup resumes only when the user runs `destroy` again (:361-390); there is no automatic completion.
- Callees: `inspectPreviewDeletion`/`destroyPreview` t:runtime-application, `lifecycle.retire` t:runtime-lifecycle.

## 5. Improvements verified from issues 83-92, 100 and 101

| Issue | Claim | Verified at |
| --- | --- | --- |
| #83 | Observation budget and deadline are injectable; expiry degrades to `unknown` instead of hanging | `runtime/bounded-observations.ts:4-14, 24-73`; `runtime/status.ts:38-43, 119-126`; `tests/controlled-observation-deadline.ts` |
| #84 | Readiness timing injected through `createTargetLifecycle(effects, timing?)` | `runtime/lifecycle.ts:68-87, 325`; `tests/readiness-timing.test.ts` |
| #85 | One `projectStatusSchema` / `ProjectStatusReader` shared by client and CLI | `domain/project-status.ts:3-106`; `daemon/client.ts:2-5, 51`; `cli/types.ts:14`. Not yet adopted by the remote helper (:40-53) |
| #86 | `connectDaemon(root)` is probe-free; `createCliClient(root, cwd)` owns the offline-doctor policy | `daemon/connection.ts:5-18`; `src/index.ts:46-62` |
| #87 | `relative_root` rejected at resolve time | `config/resolve.ts:71-78` |
| #88 | `createProjectDiscovery(run)` owns realpath and runner | `git/project.ts:26-39`; `adapters/project-documents.ts:26` |
| #89 | `activateDeployment` takes an explicit intent; `persistTarget` narrows to `Pick<StateStore,"update">`; `RigError.causes` closed | `runtime/deploy.ts:18-24`; `runtime/targets.ts:181-190`; `domain/errors.ts:4-16, 48-81` |
| #90 | `selectPorts({ requests, occupied, policy })` is a single declared call | `runtime/contracts.ts:68-82`; `adapters/runtime-files.ts:11-28`; `runtime/targets.ts:159-163` |
| #91 | `ProcessInspection` adapter with EPERM fallback | `providers/process-inspection.ts:18-22, 42-59` |
| #92 | `recordingTime` injected; `CliDependencies.wait` required; `waitForLogPoll` releases its timer on abort | `adapters/target-effects.ts:32, 128`; `cli/types.ts:22-23`; `adapters/log-follow-scheduler.ts:1-13` |
| #100 | Interpolated localhost bind ports accepted | `config/resolve.ts:338` region (`invalid_binding`) |
| #101 | `--destroy` only for previews at the grammar; `destructionPending` persisted before deletion; deletion root verified by identity, scope, device and protected paths | `cli/commands.ts:116-138`; `runtime/application.ts:361-391`; `adapters/preview-storage.ts:42-110, 172-185` |

## 6. Remaining findings, prioritized

Severity is about how far the dishonesty spreads up the tree, not about user-visible bugs. Under `function-design`, an adapter that names its effects may own ambient OS acquisition, so a defaulted runner or clock inside a provider factory is not by itself a defect. The first item is therefore labelled as a design preference with the caller and test consequences that motivate it.

### Design preference (medium): move the ambient defaults from provider factories to the composition root
- Evidence: `composition.ts:64,65,96` construct `createArtifactInstaller()`, `createCaddyRouter({...})` and `createGitSourceStore({ root })` without `run`; `:42-48` construct both supervisors without `run`, `now`, `inspection` or `identity`. Each factory then defaults ambiently: `artifact-installer.ts:35`, `caddy-router.ts:31`, `git-source-store.ts:24`, `child-supervisor.ts:66-67`, `launchd-supervisor.ts:32-34`, `process-inspection.ts:32-35`, `process-identity.ts:10`.
- Why it matters: each factory is an adapter and may legitimately own these effects; the cost is at the callers. `createRuntime` is honest, but its `RuntimeDependencies` are built from objects whose real dependencies are invisible one level down, so the first undeclared edge on every deploy path is a defaulted option rather than a named injection. Tests that inject `run` exercise a different wiring than production, and the composition root already injects `runCommand` into three siblings, so the inconsistency is the concrete harm.
- Fix: make `run` (and for supervisors `now`/`inspection`/`identity`) required on the option types, and pass `runCommand` once from `composeDaemon`, exactly as it already does for `createTargetEffects`, `createProjectDocuments` and `createDeploymentSources`. Keep test convenience in a `tests/` helper rather than in production defaults.

### High: `createChildSupervisor` declares `now`/`inspection` but its probes and stop timing bypass them
- Evidence: `child-supervisor.ts:149` calls `process.kill(owned.pid, 0)` directly. `ProcessInspection` (`process-inspection.ts:18-22`) offers `identity`, `groupExists` and `signalGroup` only; `kill` is a factory option (:23-26), not part of the interface, and `groupExists` probes a process group, so it is not a drop-in substitute for a single-pid liveness check. `:212-220` use `Date.now` and `Bun.sleep(20)` directly while the `now` option only feeds restart windows and log timestamps, so the clock seam is partial: tests can control restart-window calculations, but the actual restart delay and stop deadline still use platform timing.
- Fix: add a single-pid liveness capability to `ProcessInspection` (a distinct design decision, not a reuse of `groupExists`), and add a `sleep` (or a `SupervisorTiming` like `ReadinessTiming`) to `ChildSupervisorOptions`. Tests in `providers-process-stop` would then run without real time.

### Medium: `createTargetEffects.health` and `prepare` hide policy
- Evidence: global `fetch` at `target-effects.ts:150`; package-manager selection by lockfile at `:291-304`; timeouts 120000/2000/600000 at `:98-115, 162, 311`.
- Fix: add `fetch` to `TargetAdapterOptions`; extract `selectPackageManager(files): string[]` as a pure function next to the installer with a direct test; move the three timeouts into a named `EffectTimeouts` option with the current values as the exported default.

### Medium: `createProjectDiscovery(run)` reads `process.env` inside the factory
- Evidence: `git/project.ts:33`. `composeDaemon` already builds a filtered `environment` at `:54-58` and passes it to `createTargetEffects`, so the value exists at the call site.
- Fix: `createProjectDiscovery(run, env)`.

### Medium: monitor loop and runtime swallow diagnostic failures
- Evidence: `composition.ts:145` `.catch(() => {})` on `monitorRuntimeFailures`; no `deadline` passed :139-143; `application.ts:437-451, 482-484, 547, 567` swallow diagnostic write failures. The CLI surfaces the same failure (`cli/rig.ts:54`).
- Fix: let `deps.diagnostic` return `DiagnosticWriteResult` and have the runtime read it, instead of the composition closure (`composition.ts:104-110`) discarding the result; and record a single `monitor.failed` entry (or a counter exposed on `/health`) rather than dropping monitor exceptions. Pass `deadline: timerObservationDeadline` explicitly so the production choice is visible.

### Medium: `readDaemonToken` collapses every failure into `DAEMON_MISSING`
- Evidence: `daemon/files.ts:64-70`. `connectDaemon` then tells the user to run `rigd install` (`connection.ts:9-13`) even for EACCES or a corrupt token file, and `isDaemonUnavailable` (`connection.ts:21-24`) lets `doctor` go offline on the same misclassification.
- Fix: return `DAEMON_MISSING` only for ENOENT; map other errors to `DAEMON_STATE` as `readRecord` :17-48 already does for the address file.

### Medium: `doctor` reports every failure as `config-invalid`
- Evidence: `runtime/doctor.ts:83-91, 141-149`. `inspectOfflineHost` does the same but at least distinguishes `ConfigError` from other errors (`offline-doctor.ts:34-47`).
- Fix: use the `ConfigError.code` as `reason` and a separate `inspection-failed` reason for non-config errors.

### Low: `createHostDiagnosticLog` silent fallback (B T3)
- Evidence: `host-log.ts:16`.
- Fix: on fallback, record one `host-config.invalid` warning entry through the default log so the evidence trail says why policy was ignored.

### Low: `Promise<unknown>` results at four seams
- Evidence: `application.ts:33`, `cli/types.ts:15`, `remote-helper.ts:22`, `host.ts:11`. Every consumer re-parses: `interaction.ts:156-165`, `remote-helper.ts:40-60`, `cli/output.ts:120-127`.
- Fix (incremental): give the remote helper `client: ProjectStatusReader & { command }` and delete its local `status` schema, keeping the helper's stricter `isGitCommit` refinement on `commit` (either by tightening the shared schema or by re-validating the commit at the helper); then introduce a per-action result union in `daemon/protocol.ts` so `handle` and `command` can be typed without a big-bang change.

### Low: `DaemonClient` fixed deadlines and per-command reconnect in the helper (B U2)
- Evidence: `client.ts:37,47,66`; `remote-helper.ts:340-344` re-reads address and token for every `list for-push` and every push.
- Fix: `DaemonClient` constructor takes `{ address, timeouts }` with the current values exported as a default. The per-command reconnect is the #86 freshness contract (`connection.ts:5`; `tests/daemon-connection.test.ts:7` asserts re-reading after a restart), so connecting once per helper session would be a deliberate contract change, not a cleanup. If it is wanted, state it in the `RemoteHelperDependencies.client` doc; otherwise keep per-operation freshness and only share the timeout defaults.

### Low: `DaemonAdmin` defaults its clock and id; uid fallback duplicated
- Evidence: `admin.ts:53-59` default journal `now`/`id`; `admin.ts:289` and `composition.ts:45` both use `process.getuid?.() ?? 501`.
- Fix: `rigd.ts` passes `now`/`id` like `index.ts` does; compute the launchd domain once in `rigd.ts` and pass it to both.

### Low: launchd and capture helpers own fixed sleeps
- Evidence: `launchd-supervisor.ts:91, 184`; `capture-status.ts:35-64`; `captured-process.ts:23, 48, 64`.
- These are adapter internals and acceptable as `[O]`, but they are the reason `providers-launchd*` tests need real time. Same `sleep` option as the child supervisor would cover them.

### Low: provider errors carry raw stderr in `details`
- Evidence: `git-source-store.ts:33`, `caddy-router.ts:117, 143`, `launchd-supervisor.ts:45`. `git/project.ts` never does this.
- Current impact is nil: `server.ts:112-121` serializes only code/message/hint, `reportFailure` never renders details, and `diagnosticRecord` :23-30 has a closed key list. The inconsistency is only a maintenance hazard if a future channel starts serializing `details`. Either strip stderr before constructing the error or document that `details` is test-only.

### Informational (persisting, no change recommended)
- `/health` returns `process.pid` (`server.ts:53`), consumed by `DaemonAdmin.status`. Local, authenticated, and useful.
- `prepareInteractiveRequest` writes the detached-HEAD notice (`interaction.ts:139-142`). The channel is declared in its `deps` type; it is just an odd place for a notice.
- `deployment-context` swallows `GIT_DETACHED` into `currentBranch: null` (`application.ts:184-191`). The consumer explains it.
- `effect-transactions` tolerates a stale checkpoint (`:186-187`) after a swallowed `removeCheckpoint` (`:249-251, 310-312`). Intentional, but untested by name.
- `inspectHost` uses `Bun.which` (`host-inspection.ts:43`). That is what a doctor does; add one doc line.

## 7. Simplifications that would remove dishonesty rather than relabel it

1. One `ProviderRuntime` record `{ run, now, sleep, id, kill }` built once in `composeDaemon` and passed to every provider factory. Removes seven ambient defaults and makes 6.1 and 6.2 mechanical.
2. Delete the remote helper's local `status` schema and take `ProjectStatusReader` (already exists) plus `command`, while retaining the helper's `isGitCommit` check on `commit`. Removes one duplicated contract without loosening push acknowledgement.
3. Replace the result-discarding `diagnostic` closure in `composition.ts:104-110` with the `DiagnosticLog` itself in `RuntimeDependencies`, so the runtime reads the same `{ error }` result the CLI reads. Removes the lost-result path and gives the four catch sites a value to record instead of an exception to drop.
4. Export the three effect timeouts and the child-supervisor stop deadlines as one named default object each, mirroring `readinessTiming` and `timerObservationDeadline`. No behavior change; the numbers become visible at the boundary.
5. Add one single-pid liveness capability to `ProcessInspection` and use it from both `processExists` (`host.ts:125-132`) and `child-supervisor.ts:149`. `groupExists` is not that capability; it answers a different question.

## 8. Tests that would raise trust on unmarked callees

Not referenced by name in any test file at this commit:
- `boundedObservations` directly (covered through `observeTargets` in `runtime-status` and through `monitorRuntimeFailures` in `activity-crashes`, which shares the batching at `activity.ts:31-38`).
- `createHostDiagnosticLog` fallback path (`host-log.ts:16`).
- `inspectOfflineHost` (`offline-doctor.ts`).
- `readDaemonToken` error mapping (`files.ts:57-71`).
- `readTargetLogs` / `decodeCursor` directly (only via `runtime-logs` through `createRuntime`).
- `projectStatus`, `planTarget`, `persistTarget`, `updateRegistration`, `doctor`, `createDeploymentSources` (all exercised only through `runtime-application`).
- `createEffectPreparation` by name (the `effect-preparation` test targets transactions and ownership).
- `readCaptureObservation` freshness cutoff (`capture-observation.ts:74`).
- The stale-checkpoint tolerance in `effect-transactions.ts:186-187`.

## 9. Trees not traced

- `src/adapters/terminal-interaction.ts`, `src/cli/terminal-text.ts`: adapter and pure helper; not on a policy path.
- `src/migration/{convert,files,schema,source-evidence,types,index}.ts`: only `adoption.ts` was traced because it is the runtime gate.
- `src/runtime/state-schema.ts`, `src/config/schema.ts`, `src/config/editor.ts`, `src/config/errors.ts`, `src/config/index.ts`, `src/domain/git.ts`: grepped for `process.`, `Date`, `randomUUID`, `setTimeout`, `fetch(`, `console.` (none found except `documents.ts:322`); field-level schema behavior not audited.
- Test bodies: only file names and function-name references were inspected. No assertion content was read, so trust marks mean "a test names it", not "a test proves the contract".

## 10. Coverage index

Read in full with line evidence: `src/index.ts`, `src/rigd.ts`, `src/cli/{commands,entry-environment,failure,interaction,output,rig,rigd,types}.ts`, `src/daemon/{admin,client,composition,config-editor,connection,files,host,offline-doctor,protocol,server}.ts`, `src/runtime/{activity,application,bounded-observations,contracts,deploy,doctor,lifecycle,ports,project-status,projects,registration,state-store,status,stop,targets}.ts`, `src/domain/{errors,project-status,runtime}.ts`, `src/config/{documents,resolve,types}.ts`, `src/git/{preflight,project,remote-helper,remotes}.ts`, `src/adapters/{admin-activity,artifact-ownership,deployment-sources,effect-preparation,effect-transactions,host-inspection,log-follow-scheduler,preview-storage,project-documents,runtime-files,target-effects,target-log-reader}.ts`, `src/providers/{artifact-installer,caddy-router,capture-observation,capture-status,captured-process,child-supervisor,command-runner,contracts,git-source-store,launchd-supervisor,process-identity,process-inspection}.ts`, `src/diagnostics/{file-log,host-log,types}.ts`, `src/migration/adoption.ts`.

Grepped only: listed in section 9.

Not opened: the parallel Codex report, compiled binaries, `~/.rig`, and any live daemon state.
