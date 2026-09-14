# Function-honesty tree with upward propagation — whole system

Repo `b-relay/rig` at HEAD `470a510`, 2026-09-10. Source review; fragments were
produced by four reviewers (CLI, daemon, runtime, providers/git/config/migration)
and are reproduced verbatim in the appendices with their ledgers and line
references. This head document merges them into one tree and applies the
propagation rule the request asked for.

## Rule applied

A function is **honest** when its signature shows every behaviour-affecting
dependency and every observable channel (function-design skill, rule 1). A
dishonest callee makes its caller dishonest, because the caller's signature
now hides whatever the callee hides. In this document that propagation is
carried **all the way to the process entry point**, not stopped at the nearest
effect owner. Effect owners (`main`, `composeDaemon`, adapters that acquire a
channel) are dishonest by design, so for them the propagation only adds an
inherited reason to a mark they already carry; that is stated per node.

Marks:

| Mark | Meaning |
| --- | --- |
| `[H]` | honest |
| `[D]` | dishonest by its own defect (hidden dependency or channel in its own body) |
| `[T]` | dishonest only by inheritance from a `[D]` or `[T]` callee; **would be honest otherwise** |
| `[D+T]` | own defect and inherited poison; fixing only the inheritance leaves `[D]` |
| `[O]` | effect owner by design (acquires an ambient channel and says so); `[O+T]` = owner that also inherits poison |
| `[B]` | boundary marked in another fragment |

"Would be honest otherwise" is written out for every `[T]` and `[O+T]` node as
the exact set of callee fixes that would clear it.

## Reconciliation between fragments

- `createRuntime` (`src/runtime/application.ts:49`): the runtime fragment
  treated it as an owner; the daemon fragment marked it `[D+T]`. It acquires no
  ambient channel itself (everything arrives through `RuntimeDependencies`), so
  it is not an owner. Its own defect is the observation deadline chosen by
  omission at `:88` and `:114`; the rest is inherited. Final mark: `[D+T]`.
- `createProjectDiscovery` (`src/git/project.ts:32`): the daemon fragment
  called it `[O]` ("owner-level acquisition inside a factory"); the providers
  fragment called it `[D]` because a factory whose contract is "discovery over
  `run`" silently reads `process.env`. The contract does not name the
  environment, so `[D]`.
- Provider factories (`createChildSupervisor`, `createLaunchdSupervisor`,
  `createArtifactInstaller`, `createCaddyRouter`, `createGitSourceStore`): each
  declares optional capabilities and defaults them to real ones. As composed by
  `composeDaemon` none of the options are passed, so the defaults are live.
  Marked `[D]` (own defect: defaulting) plus `[T]` where methods add more.

## 1. Whole-system tree (condensed; every node carries its final mark)

Line references are in the appendices. `→` means "calls"; indentation is the
call tree. Nodes that are honest in the fragments and stay honest here are
listed once and not expanded.

```
rig: main(args) [O+T] src/index.ts:10
  rigRoot, userOutput, createHostDiagnosticLog, waitForLogPoll, createTerminalInteraction  [O]
  createCliClient(root, cwd) [O+T] src/index.ts:47
    connectDaemon → readDaemonAddress/readDaemonToken/DaemonClient  [O] (owner defects: token collapse #116/#121, timeout collapse #127)
    inspectOfflineHost(root, cwd) [D] src/daemon/offline-doctor.ts:12
      inspectHost(root) [O] (fat), discoverProject [O]
  runRigCli(args, deps) [H] src/cli/rig.ts:10 — and its entire static subtree [H]
    createRigCommand, prepareInteractiveRequest, followLogs, renderStatus/renderResult, reportFailure, recordDiagnostic  [H]

rigd: main(args) [O+T] src/rigd.ts:10
  rigRoot, daemonCommand, userOutput, createHostDiagnosticLog  [O]
  runCapturedProcess(requestPath) [O+T] src/providers/captured-process.ts:19   (capture wrapper entry)
    createChildSupervisor({stateRoot}) [D+T]  (see providers)
    createProcessIdentityReader() [D] src/providers/process-identity.ts:9   (default run)
    writeCaptureStatus, writeCaptureObservation  [H]
  DaemonAdmin (install/uninstall/status) [O] src/daemon/admin.ts   (owner defects: #121 #132 #138 #139 #140)
  runDaemonHost(options) [O] src/daemon/host.ts:17   (owner defects: #131 #137 #139)
    startControlPlane(options) [O] src/daemon/server.ts
  composeDaemon(root, captureCommand) [O+T] src/daemon/composition.ts:31   (fat owner; monitor policy inline #118)
    readHostConfig, createFileDiagnosticLog, FileStateStore, createAdminActivityJournal, inspectHost, createRuntimeFiles  [O]
    createAdoptionGuard(root) [O] src/migration/adoption.ts:192 → readLegacyAdoption [O fs] → parseManifest, validateEvidence [H]
    createProjectDocuments(root, run) [O+T] src/adapters/project-documents.ts:22
      createProjectDiscovery(run) [D] src/git/project.ts:32   (process.env :33)
      inspectInitialization(path, command, discovery) [D] src/adapters/project-documents.ts:86   (hidden readProjectConfig :101)
        inspectProjectLocation, projectSlug [H]
      ensureProjectGit, renameRigRemote, ensureRigRemote, inspectRigRemote [H]
      discoverProject, readProjectConfig, readHostConfig, initializeProjectConfig, editProjectConfig [O fs]
      resolveTargetPlan(input) [H] src/config/resolve.ts:70 — and its entire subtree [H]
    createChildSupervisor(options) [D+T] src/providers/child-supervisor.ts:56   (defaults now/inspection :66-67)
      createProcessInspection() [D] src/providers/process-inspection.ts:29   (defaults run/kill)
      observe(key) [D] :118   (process.kill(pid,0) :149)
      stop(key) [D] :177   (Date.now/Bun.sleep :212-220)
      scheduleRestart(request, code) [D+T] :235   (setTimeout :250; re-enters ensureRunning)
      ensureRunning(request) [T] :269   ← observe, waitForCaptureStart, stop, scheduleRestart
        waitForCaptureStart(requestPath) [D] src/providers/capture-status.ts:35   (Date.now/Bun.sleep)
        captureOutput, clearCaptureStatus [H]
      shutdown() [T] :386   ← stop
      serialized, recover, inspect [H]
    createLaunchdSupervisor(options) [D+T] src/providers/launchd-supervisor.ts:31   (defaults run/inspect/now :32-34)
      waitForApplication(key) [D] :87   (Bun.sleep ×30)
      stop(key) [D] :155   (Bun.sleep ×30)
      ensureRunning(request) [T] :102   ← waitForApplication, waitForCaptureStart
      observe(key) [H given run/inspect/now] :49 → readCaptureObservation [H]
      launchdPlist, xml, checked, shutdown [H]
    createArtifactInstaller(options) [H] src/providers/artifact-installer.ts:29   (FIXED #229: run and bunExecutable required; composeDaemon passes runCommand / process.execPath)
      install(request) [H given run, bunExecutable] :36   (FIXED #229: no Bun.which)
      observe(path), shellQuote, isSourceEntrypoint [H]
    createCaddyRouter(options) [D] src/providers/caddy-router.ts:23   (default run); all methods [H given run]
    createGitSourceStore({root}) [D+T] src/providers/git-source-store.ts:20   (default run)
      prepare(request) [D] :37   (resolve() against process.cwd :70,:85,:103)
      git(args), exists [H]
    createDeploymentSources(store, run) [T] src/adapters/deployment-sources.ts:6   ← store.prepare
      preflightDeployment, resolve, currentBranch, git [H]
    createTargetEffects(options) [O] src/adapters/target-effects.ts:57   (adapter over supervisors/installer/router)
    createTargetLifecycle(effects, …) [H] (retire/up/activateDeployment — honest against the TargetEffects interface)
    createRuntime(deps) [D+T] src/runtime/application.ts:49   (own: default observation deadline at :88 prepare-uninstall, :114 list)
      status(selection) [T] :52 ← selectProject [D latent], projectStatus [D]
        selectProject(command, deps) [D latent] src/runtime/projects.ts:8   (path.resolve → process.cwd for relative repoPath)
        projectStatus(project, targets, sel, deps) [D] src/runtime/project-status.ts:16   (default deadline :51)
          observeTargets, boundedObservations, targetName, configuredComponents, aggregate [H]
      execute(command) [D+T] :65   (same body as createRuntime's own defect; closure)
        up / down / restart / destroy branches [H own] → planTarget [H], persistTarget [H], stopRecordedTarget [H], stopForRecovery [H], activateDeployment [H]
        deploy / git-push branch [H own] → activateDeployment [H], lifecycle.retire [H]
        doctor branch → doctor(project, targets, deps) [D] src/runtime/doctor.ts:59   (default deadline :155); hostDoctor [H]
        init / register branches → registerProject, assertRegistrationAvailable [D latent] src/runtime/projects.ts:56,:114
        rename / repoint → updateRegistration(command, project, targets, deps) [D] src/runtime/registration.ts:7   (default deadline :13; mutates project.name :75 with void return)
        logs → readTargetLogs [O fs] (adapter, declared)
      command(command) [T] :525 ← execute
      monitorRuntimeFailures / reconcile [T] ← observeTargets default deadline through the same path

git-remote-rig: main(args) [O+T] src/git/remote-helper.ts:310
  createProjectDiscovery(runCommand) [D] src/git/project.ts:32   (process.env)
  inspectProjectGit(cwd, discovery) [H], createGitPushSource(repoPath, run) [H]
  connectDaemon, createHostDiagnosticLog [O]  (via CLI fragment)
  runRemoteHelper(url, deps) [H] src/git/remote-helper.ts:66 — and its entire subtree [H]

migration publication roots (no caller in src/, #145): readLegacyState, migrateLegacyState, finalizeLegacyAdoption [O fs]
  convertLegacyState, resolveProjects, convertPlan, orderComponents, planAdoption, recoverSources, parseSource [H]
```

## 2. Propagation chains, leaf to root

Each row is one own-defect leaf. The chain lists every ancestor it poisons up
to the process entry. For each poisoned ancestor the "otherwise" column says
what would clear it.

| # | `[D]` leaf (own defect) | Chain to root (marks after propagation) | Would be honest otherwise |
| --- | --- | --- | --- |
| 1 | `inspectOfflineHost` `src/daemon/offline-doctor.ts:25,:27` hard-wires `inspectHost` (PATH via `Bun.which`, host config file) and `discoverProject` (walk to `/`) | → `createCliClient` `[O+T]` → `rig main` `[O+T]` | `inspectOfflineHost` itself: yes, accept `{inspectHost, discoverProject}` like the runtime does. `createCliClient`/`main`: owners by design; inherited reason clears with that one fix. |
| 2 | child `observe` `child-supervisor.ts:149` `process.kill(pid,0)` bypasses `inspection` | → child `ensureRunning` `[T]` → `createChildSupervisor` `[D+T]` → `composeDaemon` `[O+T]` → `rigd main` `[O+T]`; also → `runCapturedProcess` `[O+T]` | `observe`: yes, via `inspection.groupExists`. `ensureRunning`: yes if 2, 3, 4, 5 are all fixed. |
| 3 | child `stop` `child-supervisor.ts:212-220` `Date.now`, `Bun.sleep`, hidden 1500 ms kill grace despite received `now` | → `ensureRunning` `[T]`, `shutdown` `[T]` → `createChildSupervisor` → `composeDaemon` → `rigd main`; → `runCapturedProcess` | `stop`: yes with `now()`-derived deadlines and an injected sleep (#120, #146). `shutdown`: yes if 3 is fixed. |
| 4 | child `scheduleRestart` `child-supervisor.ts:250` `setTimeout` undeclared | → `captureOutput` (honest; callback only) → `ensureRunning` `[T]` → factory → owners | `scheduleRestart`: `[T]` even after a timer capability is added, because it re-enters `ensureRunning`; clears when 2, 3, 5 clear (#120). |
| 5 | `waitForCaptureStart` `capture-status.ts:39-57` `Date.now`, `Bun.sleep` | → child `ensureRunning` `[T]` and launchd `ensureRunning` `[T]` → both factories → `composeDaemon` → `rigd main` | yes, accept `{now, sleep}`. |
| 6 | `createProcessInspection` `process-inspection.ts:32-35` defaults `run`/`kill` | → `createChildSupervisor` `[D+T]` → owners | yes, require both; its members are already honest given them. |
| 7 | `createChildSupervisor` `child-supervisor.ts:66-67` defaults `now`, `inspection`; `composeDaemon:42` passes neither | → `composeDaemon` `[O+T]` → `rigd main`; → `runCapturedProcess` `[O+T]` | own defect clears by requiring the options (or passing them at `composition.ts:42`); stays `[T]` until 2-5 clear. |
| 8 | launchd `waitForApplication` `launchd-supervisor.ts:88-91` 30 × `Bun.sleep(100)` | → launchd `ensureRunning` `[T]` → `createLaunchdSupervisor` `[D+T]` → `composeDaemon` → `rigd main` | yes with an injected sleep/poll budget (#144 shows the concrete false failure). |
| 9 | launchd `stop` `launchd-supervisor.ts:171-184` 30 × `Bun.sleep(100)` | → `createLaunchdSupervisor` → owners | yes, same fix. |
| 10 | `createLaunchdSupervisor` `launchd-supervisor.ts:32-34` defaults `run`, `inspect`, `now`; `composeDaemon:43-48` passes none | → `composeDaemon` → `rigd main` | own defect clears by requiring; stays `[T]` until 5, 8 clear. |
| 11 | ~~installer `install` `artifact-installer.ts:66` `Bun.which("bun")` when `bunExecutable` absent~~ FIXED (#229): `bunExecutable` is required; `composeDaemon` passes `process.execPath`. | (cleared) | done. |
| 12 | ~~`createArtifactInstaller` `artifact-installer.ts:35` default `run`~~ FIXED (#229): `run` is required; `composeDaemon` passes `runCommand`. | (cleared) | done. |
| 13 | `createCaddyRouter` `caddy-router.ts:31` default `run`; `composeDaemon:65-79` passes none | → `composeDaemon` → `rigd main` | yes; every method is honest given `run`. |
| 14 | store `prepare` `git-source-store.ts:70,:85,:103` `resolve()` against `process.cwd()` | → `createGitSourceStore` `[D+T]` → `createDeploymentSources` `[T]` → `composeDaemon` → `rigd main` | `prepare`: yes with absolute-path validation or a `cwd` input. `createDeploymentSources`: yes if 14 and 15 clear (it declares both capabilities). |
| 15 | `createGitSourceStore` `git-source-store.ts:24` default `run`; `composeDaemon:96` passes only root | → `createDeploymentSources` `[T]` → owners | own defect clears by requiring; `[T]` until 14 clears. |
| 16 | `createProjectDiscovery` `git/project.ts:33` reads `process.env` in the factory | → `createProjectDocuments` `[O+T]` → `composeDaemon` → `rigd main`; → `git-remote-rig main` `[O+T]` | yes, accept `env` (`composeDaemon` already builds a filtered environment at `:54-58`). |
| 17 | `inspectInitialization` `adapters/project-documents.ts:101` hidden `readProjectConfig` outside the `discovery` provider | → `initializationInfo`/`identifyInitialization`/`initialize` → `createProjectDocuments` `[O+T]` → `composeDaemon` → `rigd main` | yes, add `readConfig` to `ProjectDiscovery` or pass the document. |
| 18 | `projectStatus` `runtime/project-status.ts:51` observation deadline chosen by omission | → `createRuntime.status` `[T]` → `createRuntime` `[D+T]` → `composeDaemon` → `rigd main` | yes once `RuntimeDependencies` carries `deadline`/`budgetMs` and `:51` passes them. `status`: yes if 18 and 22 clear. |
| 19 | `doctor` `runtime/doctor.ts:155` same omission (plus #119/#126 result-shape defects) | → `execute` `[D+T]` → `command` `[T]` → `createRuntime` → owners | yes with the same timing fix. |
| 20 | `updateRegistration` `runtime/registration.ts:13,:75` same omission; mutates `project.name` with `void` return | → `execute` → `command` → `createRuntime` → owners | (1) clears with the timing fix; (2) clears by returning the renamed record instead of mutating the argument. |
| 21 | `createRuntime` own `application.ts:88,:114` `observeTargets` default deadline in `prepare-uninstall` and `list` | → `composeDaemon` `[O+T]` → `rigd main` | own defect clears with the timing fix; stays `[T]` until 18-20, 22, 23 clear. |
| 22 | `selectProject` `runtime/projects.ts:46` (latent) `path.resolve` reads `process.cwd()` for relative `repoPath` | → `status` `[T]`, `execute` → `command` → `createRuntime` → owners | yes, forbid relative `repoPath` in the state schema or take `cwd`. Latent: the CLI always sends absolute paths today. |
| 23 | `registerProject` / `assertRegistrationAvailable` `runtime/projects.ts:78,:121,:126` (latent) same `resolve` | → `execute` → `command` → `createRuntime` → owners | same fix as 22. |
| 24 | `createProcessIdentityReader()` bare `process-identity.ts:10` default `run` | → `runCapturedProcess` `[O+T]` | yes, require `run`. |

### Which non-owner ancestors are poisoned only by inheritance (`[T]`)

These are honest in their own bodies and become honest with no change to
themselves once the listed leaves are fixed:

| `[T]` node | Poisoned by rows | Honest after fixing |
| --- | --- | --- |
| child `ensureRunning` `child-supervisor.ts:269` | 2, 3, 4, 5 | all four |
| child `shutdown` `:386` | 3 | 3 |
| launchd `ensureRunning` `launchd-supervisor.ts:102` | 5, 8 | both |
| `createDeploymentSources` `adapters/deployment-sources.ts:6` | 14, 15 | both |
| `createRuntime.status` `application.ts:52` | 18, 22 | both |
| `createRuntime.command` `application.ts:525` | 19, 20, 21, 22, 23 (via `execute`) | all |
| `monitorRuntimeFailures` / `reconcile` closures in `composition.ts` | 21 | 21 |

### Which owners carry inherited poison (`[O+T]`)

Owners stay dishonest by design; the row numbers say which inherited reasons
they would shed.

| Owner | Inherits from rows | Own owner-level defects (do not propagate; filed) |
| --- | --- | --- |
| `rig main` `src/index.ts:10` | 1 | none beyond composition |
| `createCliClient` `src/index.ts:47` | 1 | doctor fallback on any unavailability code (#127) |
| `rigd main` `src/rigd.ts:10` | 2-23 | none beyond composition |
| `composeDaemon` `src/daemon/composition.ts:31` | 2-23 | passes no capabilities to five provider factories (:42,:43-48,:64,:65-79,:96); monitor swallow (#118); `getuid ?? 501` |
| `createProjectDocuments` `adapters/project-documents.ts:22` | 16, 17 | — |
| `runCapturedProcess` `providers/captured-process.ts:19` | 2-7, 24 | catch-all rewrites `running` as `failed` (#143) |
| `git-remote-rig main` `src/git/remote-helper.ts:310` | 16 | — |

## 3. Smallest fix set that clears the most

1. **One timing capability on `RuntimeDependencies`** (`deadline`, `budgetMs`)
   passed at `project-status.ts:51`, `doctor.ts:155`, `registration.ts:13`,
   `application.ts:88,:114`: clears rows 18, 19, 20(1), 21 and therefore
   `status`, `command`, and `createRuntime`'s own mark. `createRuntime` then
   becomes `[T]` on rows 22-23 only, which are latent.
2. **`composeDaemon` passes `run`, `now`, `processInspection`, `inspect`,
   `bunExecutable`, `executable`, `env`** to the five factories and to
   `createProjectDiscovery`, and the factories make them required: clears rows
   6, 7, 10, 12, 13, 15, 16 at once. Remaining provider dishonesty is then the
   method-level timers and probes (rows 2, 3, 4, 5, 8, 9, 11, 14), each a
   one-parameter change (#120 covers the timers).
3. **`inspectOfflineHost` receives its two observations** (row 1): the CLI
   side becomes fully honest below `main`.
4. **`inspectInitialization` gets `readConfig` through `ProjectDiscovery`**
   (row 17).

After 1-4, every non-owner in the system except `prepare` (row 14, needs an
absolute-path rule) and `projects.ts` (rows 22-23, latent) is `[H]`, and every
owner carries only its own owner-level defects.

## 4. Honest regions (unchanged by any fix)

- The whole `runRigCli` subtree: grammar, interaction, rendering, failure
  policy, log following.
- The whole `runRemoteHelper` subtree and `createGitPushSource`,
  `inspectProjectGit`, `remotes.ts`, `preflight.ts`.
- All of `src/config/resolve.ts`, `schema.ts`, `editor.ts`, and the pure
  document helpers; every fs contact there is an `[O fs]` owner.
- All migration calculations (`convert.ts`, `source-evidence.ts`, manifest
  parsing and validation).
- Runtime orchestration below `createRuntime`: `planTarget`, `persistTarget`,
  `activateDeployment`, `createTargetLifecycle`, `stopRecordedTarget`,
  `stopForRecovery`, `observeTargets`, `boundedObservations`, `hostDoctor`.

## 5. Concrete bugs found during the review, and where they were filed

| Finding | Issue |
| --- | --- |
| empty/unreadable token → `DAEMON_MISSING`; `rigd install` raw EEXIST | #121 (#116 concurrent) |
| `RIG_ROOT=""` uses cwd | #122 |
| preview replacement: retire failure after commit | #123 |
| replacement retires oldest preview without destroying storage | #124 |
| Convex site port discarded for local/live | #125 |
| doctor `config-invalid` instead of drift for new dynamic-port component | #126 (#119 concurrent) |
| doctor 5 s timeout → offline "not reachable" | #127 |
| first Ctrl-C after submission consumed; Ctrl-C at prompt exits 1 | #128, #129 |
| stale admin-activity lock never reclaimed | #130 |
| `release()` throws on corrupt address/owner json | #131 |
| reachable daemon without install marker uninstallable | #132 |
| monitor swallows errors | #118 (#133 closed as duplicate) |
| `displayWord` sanitizer weaker than `terminalText` | #134 |
| localhost bind check bypassed via `sh -c`; hooks/env unchecked | #135 |
| `up`/`restart` on local never re-plans; `deploy local` rejected | #136 |
| SIGTERM force-closes in-flight requests | #137 |
| pid reuse bricks install/uninstall/start | #138 |
| stale `acquiring` lock unrecoverable via CLI | #139 |
| cleanly stopped daemon cannot be uninstalled | #140 |
| `state.activity` unbounded; usage mistakes recorded | #141 |
| minor daemon messaging gaps | #142 |
| capture wrapper catch-all rewrites `running` as `failed` | #143 |
| launchd `ensureRunning` false `LAUNCHD_START` during backoff | #144 |
| migration roots unreachable; adoption guard can wedge | #145 |
| provider minor hazards (non-atomic request JSON, `process.kill(0)` probe) | #146 |
| bearer token sent to whatever owns a stale daemon port | #147 |
| editing Project name in config leaves a circular dead end | #148 |
| user-correctable failures rendered as unexpected; no CLI pre-validation | #149 |
| minor CLI gaps (Details without Operation, empty branch, hashed slug, no --version) | #150 |
| crash between effect and journal capture bricks the Target | #151 |
| repoint skips port reservation | #152 |
| superseded revisions/worktrees/markers never removed | #153 |
| drift hint "Deploy to apply" is a same-Commit no-op | #154 |
| up starts incomplete Deployment, flag never cleared | #155 |
| installer shell environment inherited by rigd, components, hooks; persisted to capture JSON | #156 |
| sqlite path / envFile unconfined to workspace or data root | #157 |
| stale `rig.yaml.lock` blocks every edit | #158 |
| symlinked `rig.yaml`/Caddyfile replaced by a regular file on edit | #159 |
| `git push rig` hangs forever on fatal helper errors (readline never closed) | #160 |
| push from a linked worktree rejected with `PROJECT_PATH_CONFLICT` | #161 |
| `init --domain` scaffolds one hostname for every Target → `ROUTE_CONFLICT` | #162 |
| lane `hooks` override replaces the whole object; `env` merges per key | #163 |
| config validation gaps (union "Invalid input", spurious `base.` override error, interpolation without path, Caddy-invalid domains, `ports` namespace collision, `.bak` litter) | #164 |
| Target log reader cannot skip one bad record (oversized newline-free line, glued partial line) | #165 |
| deleted log directory silently drops output; status strips the recorded reason | #166 |
| `rig activity` hides message and Operation id; no `rig result` | #167 |
| diagnostic rotation disabled forever after a partial first record | #168 |
| minor logs gaps (UTC times, cursor error on unreadable file, wrapper logs invisible, no Target log rotation, build output burst) | #169 |
| readiness never re-observes the process: foreign listener certifies, immediate exit reported started, dead process waits full readyTimeout | #171 |
| missing envFile → raw ENOENT → `UNEXPECTED` | #172 |
| health URL localhost check bypassed by userinfo quote / uppercase scheme | #173 |
| `deploy --no-up` on a running live Target stops production | #174 |
| `occupied` ignores `recovery.plan` ports | #175 |
| health minors (3xx unhealthy without reason, evidence discarded, dependsOn readiness weaker than documented, readyTimeout overflow) | #176 |
| moved repo is a dead end: `repoint .` conflicts, commands blame config, registered path never rendered | #177 |
| `init --path` registers the Git toplevel, ignores nearer `rig.yaml` | #178 |
| non-interactive `init` records the checked-out branch as Production | #179 |
| registration minors (same-name second repo, init discards flags, rename to same name, repoint non-git dir, no unregister, discovery above nested root) | #180 |
| corrupt `state.json` → rigd exits silently; doctor says healthy | #181 |
| state write has no fsync/backup; hint refers to a backup that never exists | #182 |
| `state.json` strip-mode parse, unversioned per field → downgrade drops `destructionPending`/`deploymentIncomplete` | #183 |
| `rigd install` cannot upgrade a running daemon; no binary identity; protocol skew rendered as usage error | #184 |
| strict effect journal bricks Target on downgrade; orphan journals never reclaimed | #185 |
| failed/interrupted first Preview deploy → git "Everything up-to-date" forever | #186 |
| deploys plan from the working-copy `rig.yaml`, not the pushed commit | #187 |
| Preview replacement silent and state-blind | #188 |
| preview push minors (recreated branch hint, ConfigError recorded as UNEXPECTED) | #189 |
| processSupervisor typo accepted by schema; wedges the Target at deploy | #190 |
| convex stateDir and relative sqlite paths resolved under the revision checkout: data lost per deploy | #191 |
| rename keeping installName raises ARTIFACT_CONFLICT; local up never rebuilds after source change | #192 |
| provider minors (PROVIDER_MISSING wording, redirect handling, sqlite path hint) | #193 |
| rig restart aborts after the stop half on a preStop/postStop failure: outage, desired persisted stopped | #194 |
| installation receipt key hashes the whole inherited daemon env: ambient changes rebuild everything, artifact unknown | #195 |
| hook semantics drift: installed-component hooks never run, postStart before readiness, preStart after builds, HOOK_FAILED unnamed, RIG_DAEMON_CHILD inherited, undocumented interpolation names | #196 |
| hook/build timeout reported as generic COMMAND_TIMEOUT with output discarded; timeouts hard-coded | #197 |
| envFile parser rejects `KEY="value" # comment`; ENV_FILE errors carry no path or line | #198 |
| interpolated paths unquoted in shell commands: a space in workspace or RIG_ROOT breaks ${workspace}, ${db.path} | #199 |
| doctor discards observation reason and exit code for failing components | #200 |
| status never reports destructionPending or deploymentIncomplete; doctor healthy on uncommitted deployment | #201 |
| launchd capture freshness measured after two ps inspections: flaps to unknown, blocks uninstall | #202 |
| doctor/status/list minors (aggregate never unhealthy, project note dead code, list observes for nothing, deployBranch not drift, caddy-reload check unreachable, no commit) | #203 |
| client deadline expiry reported as DAEMON_UNREACHABLE while rigd keeps executing; retry queues a duplicate | #204 |
| Caddy validate/reload stderr discarded on every path, rejected file deleted; missing caddy generic COMMAND_START | #205 |
| Caddy/daemon minors (port-unaware conflict, remove() no-op reload, capture raw stack, Origin check not a rebinding defence) | #206 |
| empty RIG_ROOT flips rigd install into launchd mode rooted at cwd (addendum) | #122 |
| rig logs --follow never exits when stdout closes: pipelines hang, orphan CLI polls rigd; follow capped at --lines per poll | #207 |
| preview Branch positional silently discarded when --deployment also passed: wrong Preview stopped or destroyed | #208 |
| CLI minors (help unknown exit 0, usage hint, rigd capture --help ENOENT, list hides ownership, empty option values dropped) | #209 |
| status/doctor during a normal in-flight deploy report unknown with a destructive "run down" hint | #210 |
| clean rigd stop kills every child; next start silently restarts all Targets and re-runs start hooks | #211 |
| lease recovery after daemon restart: leader-only ownership (dead sh leader → duplicate), keepAlive lost | #212 |
| one global mutation queue blocks unrelated Projects with no feedback | #213 |
| git push interrupted mid-deploy: no signal handling, in-flight commit advertised, re-push says up-to-date | #214 |
| git-remote-rig minors (repoint hint hijack, success line names nothing, --force same commit, --all) | #215 |
| git push over 300 s reported as rigd not reachable (addendum) | #204 |
| more helper fatal-path hangs: trailing slash, unregistered project, no daemon, :branch, ls-remote (addendum) | #160 |
| rigd LaunchAgent records the symlink-resolved bun path: brew upgrade leaves a job that can never start | #216 |
| rigd LaunchAgent unconditional KeepAlive: startup failure relaunches forever, unbounded startup.log, uninstall dead end, stderr dropped | #217 |
| launchd Target supervisor litter: observation/status files, vanished job and failed bootstrap keep plist and env JSON, unload budget | #218 |
| destroy persists destructionPending before retirement preconditions: refused destroy wedges the Preview and blocks uninstall | #219 |
| Preview records without sourceRoot can never be destroyed; same-commit deploy does not repair | #220 |
| eviction by createdAt evicts the most recently redeployed Preview; half-destroyed Preview holds a slot (addendum) | #188 |
| destroyed Previews leave stale git worktree entries in the mirror (addendum) | #153 |
| [D] inspectOfflineHost hard-wires inspectHost/discoverProject (row 1) | #224 |
| [D+T] createChildSupervisor / [D] createProcessInspection defaults; composeDaemon passes none (rows 6, 7) | #225 |
| [D] child observe process.kill(0) bypasses inspection (row 2) | #146 item 2 |
| [D] child stop Date.now/Bun.sleep/1500 ms grace; scheduleRestart setTimeout (rows 3, 4) | #120 |
| [D] waitForCaptureStart Date.now/Bun.sleep (row 5) | #226 |
| [D] launchd waitForApplication / stop 30 × Bun.sleep(100) (rows 8, 9) | #227 |
| [D+T] createLaunchdSupervisor defaults run/inspect/now (row 10) | #228 |
| ~~[D] installer install Bun.which("bun") / [D+T] createArtifactInstaller default run (rows 11, 12)~~ fixed | #229 |
| [D] createCaddyRouter default run (row 13) | #230 |
| [D] store prepare resolve() against cwd / [D+T] createGitSourceStore default run (rows 14, 15) | #231 |
| [D] createProjectDiscovery process.env (row 16) | #232 |
| [D] inspectInitialization hidden readProjectConfig (row 17) | #233 |
| [D] observation deadline by omission: projectStatus, doctor, updateRegistration, createRuntime list/prepare-uninstall (rows 18-21) | #234 |
| [D] updateRegistration mutates project.name, void return (row 20b) | #235 |
| [D latent] selectProject / registerProject resolve against cwd (rows 22, 23) | #236 |
| [D] createProcessIdentityReader default run, called bare by the wrapper (row 24) | #237 |

---

# Appendices: reviewer fragments (verbatim)


## Appendix A — CLI fragment

### Function-honesty tree: `rig` CLI entry and client side

Repo HEAD `470a510`. Source review only; line numbers are from the current files.
Governing tests run: `bun test src/cli/cli.test.ts src/cli/interaction.test.ts tests/transport.test.ts tests/daemon-connection.test.ts tests/terminal-interaction.test.ts src/diagnostics/file-log.test.ts` -> 42 pass, 0 fail.

Classification rule applied (stated once so the marks are reproducible):

- `[O]` is reserved for the function that *acquires* an ambient channel (process, env, fs, network, timer, terminal) and whose stated contract (name + signature + doc comment + result type) names that channel, or the composition point that wires such acquirers into a provider that a lower function receives as a parameter. Owner-with-defect: an `[O]` whose contract collapses or hides a distinction its callers act on; noted as `defect:` and does not propagate (per the rule that propagation stops at owners).
- A non-owner whose primary job is domain policy but which hard-wires an adapter call (instead of receiving the provider or its result through its signature) is `[D]`: the skill's "a dishonest callee makes its caller dishonest unless the caller turns the ambient access into an explicit input".
- `src/daemon/host.ts` (`runDaemonHost`, `processExists`) is **not reached** from the `rig` CLI: its only importers are `src/rigd.ts:8` and `src/daemon/admin.ts:16`. `inspectHost` lives in `src/adapters/host-inspection.ts`, not `host.ts`. Likewise `daemonCommand()` (`src/cli/entry-environment.ts:18-22`) is only used by `src/rigd.ts:17,25`. Both are excluded from this tree.

#### 1. Call tree

```
main(args) [O] src/index.ts:10-45
  ambient acquired here: RIG_ROOT/homedir via rigRoot() :11; process.cwd() :12; SIGINT/SIGTERM listeners :15-16,42-43; stdin/stderr isTTY :30; randomUUID :22; new Date :26; stdout/stderr via userOutput() :21
  thin: every ambient value is acquired once and passed as a value or provider; the only policy is "interaction only when stdin and stderr are TTYs" :30
  rigRoot() [O] src/cli/entry-environment.ts:5-7                       env RIG_ROOT, os.homedir()
  userOutput() [O] src/cli/entry-environment.ts:8-17                    process.stdout / process.stderr
  createHostDiagnosticLog({root,source,now}) [O] src/diagnostics/host-log.ts:8-21   lazy Host-policy acquisition, declared :7
    ↳ defect (owner, no propagation): readHostConfig rejection is swallowed and defaults are used with no result channel :16; no test file exists for host-log.ts
    readHostConfig(stateRoot) [O] src/config/documents.ts:201-207        fs under root (other reviewer's subtree)
    createFileDiagnosticLog(options) [O] src/diagnostics/file-log.ts:80-129   fs adapter; record() -> {path} | {error} | {} (level-filtered :89-92)   t:src/diagnostics/file-log.test.ts
      ↳ defect (owner, no propagation): record() may block up to ~2 s in the lock retry loop :137-152 (200 x setTimeout 10 ms :151); blocking is not in the contract at :79/:131 or types.ts:18
      diagnosticRecord(entry, source, timestamp) [H] src/diagnostics/file-log.ts:34-63   t:file-log.test.ts:276-324
        safeMetadata(value) [H] :64-69
      acquireLock(path) [O] :132-158                                    bun:sqlite Database :133, setTimeout :151
        hasCode(error, code) [H] :70-77
      rotateDiagnostic(path, directory, source, today) [O] :159-188     link/stat/rm on the named paths   t:file-log.test.ts:214-274
        firstRecordDay(path) [O] :190-218
        hasCode [H]
      pruneDiagnostics(directory, source, today, retentionDays) [O] :219-238   readdir/rm   t:file-log.test.ts:44-82,142-180
  waitForLogPoll(milliseconds, signal) [O] src/adapters/log-follow-scheduler.ts:2-13   timer owner, declared :1   t:cli.test.ts:658-686, tests/log-follow-entrypoint.test.ts
  createTerminalInteraction(input, output, signal) [O] src/adapters/terminal-interaction.ts:14-81   readline over the passed streams, declared :13   t:tests/terminal-interaction.test.ts
    question(prompt) [O] :19-57 (closure; readline createInterface :22; raw-mode side effect on the passed input when it is a TTY)
    cancelled() [H] :7-12
    terminalText(value) [H] src/cli/terminal-text.ts:3-8
  createCliClient(root, cwd) [O] src/index.ts:47-62   composition root for CliDependencies.client; doctor-only offline policy :56-57 declared :46   t:tests/daemon-connection.test.ts:33-69
    connectDaemon(root) [O] src/daemon/connection.ts:6-18   "acquire fresh Host discovery and credentials" declared :5   t:daemon-connection.test.ts:7-31,54
      readDaemonAddress(root) [O] src/daemon/files.ts:50-52
        readRecord(path, schema) [O] src/daemon/files.ts:17-48   readFile; ENOENT -> undefined, else DAEMON_STATE; declared :16   t:daemon-connection.test.ts:51-52
      readDaemonToken(root) [O] src/daemon/files.ts:57-71
        ↳ defect (owner, no propagation): every failure (EACCES, EISDIR, empty) collapses into DAEMON_MISSING "rigd is not installed" :64-70; no test controls the non-ENOENT case
      new DaemonClient(address) [O] src/daemon/client.ts:33-113   "Network adapter ... Replies are untrusted input" declared :32   t:tests/transport.test.ts, daemon-connection.test.ts
        status(selection) [O] :42-59     deadline 5000 fixed :47; zod re-validation :43,:51; project identity check :54-55
        command(command) [O] :60-71      deadline policy 5000 / 300000 chosen by action :66, not caller-selectable
        request(path, body, timeoutMs) [O] :72-112   global fetch :79, AbortSignal.timeout :86
          ↳ defect (owner, no propagation): any fetch rejection incl. timeout collapses into DAEMON_UNREACHABLE :89-95; no caller AbortSignal is accepted, so CliDependencies.signal cannot reach an in-flight request
    isDaemonUnavailable(error) [H] src/daemon/connection.ts:21-24
    inspectOfflineHost(root, cwd) [D] src/daemon/offline-doctor.ts:12-50
      ↳ cause: a doctor-report policy function (check names/messages/reasons/hints :16-24, :28-47) that hard-wires two adapters instead of receiving them or their results: inspectHost(root) :25 (reads PATH via Bun.which, the Host config file, and access() on root) and discoverProject(cwd) :27 (realpath + config walk from cwd up to '/'). Signature (root, cwd) does not show PATH, the walk beyond cwd, or that the result is total (never throws).
      ↳ fix: accept `{ inspectHost: () => Promise<DoctorCheck[]>; discoverProject: (path: string) => Promise<...> }` exactly as the runtime already does (src/runtime/contracts.ts:93 `inspectHost()`, src/daemon/composition.ts:91 wraps `() => inspectHost(root)`), and let createCliClient (the owner, :47) supply them; or have createCliClient acquire both observations and pass the values. With that fix the remaining callees are pure and the node is honest — no further inheritance.
      ↳ propagation: parent createCliClient is [O]; no ancestor is poisoned.
      inspectHost(root) [O] src/adapters/host-inspection.ts:7-86   "Observe local prerequisites" declared :6   t:tests/runtime-application.test.ts, runtime-review-regressions.test.ts, zz-bughunt.test.ts (runtime side only)
        ↳ fat owner: PATH lookup (Bun.which :43), access() :61,:69 and readHostConfig :10 are interleaved with check-building policy (caddy reload rule :16-26, capability list :42, messages/hints). An honest `hostChecks(observed)` over `{ hostConfig | ConfigError, which: Record<name, boolean>, stateAccess }` would leave only the observation here. Borderline [D]: PATH is not derivable from `root`.
        readHostConfig(stateRoot) [O] src/config/documents.ts:201-207
      discoverProject(startPath) [O] src/config/documents.ts:177-199   realpath :180, stat :181, locateConfig walk :183-198; declared :176
  runRigCli(args, dependencies: CliDependencies) [H] src/cli/rig.ts:10-85   t:src/cli/cli.test.ts (13 tests), tests/transport.test.ts:166-284
    contract note (step 4, not a mark change): CliDependencies.client (src/cli/types.ts:14-16) and ProjectStatusReader (src/domain/project-status.ts:104-106) carry no doc of effects/blocking/failure codes; the only statement is rig.ts:9 "the injected client owns runtime effects". Tests do control every channel through the signature, which is why this stays [H].
    requestsStructuredOutput(args) [H] src/cli/rig.ts:106-114   pure
    createRigCommand(cwd, output, execute) [H] src/cli/commands.ts:19-87   commander grammar; parseAsync(..., {from:"user"}) reads no argv/env; writeErr silenced :93   t:cli.test.ts:227-394
      terminalCommand(name, output) [H] :88-95
      projectScope(options) [H] :96-98
      addLifecycleCommands(command, cwd, execute) [H] :100-144   mutates the caller-supplied Command (authorized)
        targetRequest(action, target, branch, cwd, options) [H] :378-412   throws tagged USAGE
      addDeployCommands(command, cwd, execute) [H] :145-199
      addInitCommand(command, cwd, execute) [H] :252-295
        initRequest(cwd, options) [H] :296-377   throws tagged USAGE; resolve(cwd, path) :343 pure given cwd
        positiveInteger(value) [H] :413-421   throws commander InvalidArgumentError (mapped to USAGE by reportFailure)
      addLogsCommand(command, cwd, execute) [H] :200-235
        targetRequest [H] :378-412; positiveInteger [H] :413-421
    execute(request, options) [H] closure src/cli/rig.ts:17-58   closure-local json/operationId/exitCode :14-16
      prepareInteractiveRequest(request, deps) [H] src/cli/interaction.ts:25-147   channels declared in the Pick: client.status :41, client.command :76,:115, interaction :52,:85,:96,:101,:133, output.error :139-142, signal   t:src/cli/interaction.test.ts, transport.test.ts:223-272
        assertActive(signal) [H] :167-169
        cancelled() [H] :148-154
        readReply(schema, value) [H] :156-165   throws tagged DAEMON_PROTOCOL
        terminalText(value) [H] src/cli/terminal-text.ts:3-8
      recordDiagnostic(log, entry) [H] src/cli/failure.ts:33-42   never throws; returns DiagnosticWriteResult   t:cli.test.ts:452-494
      renderStatus(report) [H] src/cli/output.ts:35-81   pure   t:cli.test.ts:108-166
        displayWord(value) [H] :132-136
      renderResult(action, value) [H] src/cli/output.ts:3-28   pure, lossy on shape (object() :4)   t:cli.test.ts:496-560
        renderProjects [H] :29-34; renderDoctor [H] :82-94; renderLogs(value, heading) [H] :95-113; renderActivity [H] :114-119
        object(value) [H] :120-124; rows(value) [H] :125-127; word(value) [H] :129-131; displayWord [H] :132-136
      followLogs(request, initial, dependencies) [H] src/cli/rig.ts:88-104   deps.wait :95, deps.signal :94,:96, deps.client.command :97, deps.output :101   t:cli.test.ts:396-450,634-686
        renderLogs [H]; object [H]
    isHelp(error) [H] src/cli/failure.ts:43-49
    reportFailure(error, input) [H] src/cli/failure.ts:51-88   expectedCodes is a static module constant :10-30   t:cli.test.ts:168-225,562-602
      asRigError(error) [H] src/domain/errors.ts:22-36
        unexpectedFailure(causes) [H] :37-45; failureCauses(primary, recovery?) [H] :118-128; failureCategory(error) [H] :86-117
      recordDiagnostic [H] src/cli/failure.ts:33-42
  leaves: RigError [H] src/domain/errors.ts:4-16; projectStatusSchema / StatusSelection / ProjectStatusReader [H] src/domain/project-status.ts:79-106; DiagnosticEntry / DiagnosticLog [H] src/diagnostics/types.ts:3-20
```

Reading of the tree: the honest region is the entire static subtree of `runRigCli` (grammar, interaction, rendering, failure policy, follow loop) plus the pure helpers on the provider side (`isDaemonUnavailable`, `diagnosticRecord`, `safeMetadata`, `hasCode`, `terminalText`, `cancelled`). Every ambient channel the CLI uses is acquired in `main` or in a named adapter composed by `main`, and reaches `runRigCli` only through `CliDependencies`. The single non-owner defect is `inspectOfflineHost`, which sits one level below its owner (`createCliClient`) and therefore poisons no ancestor.

#### 2. Propagation summary

| [D] node | Cause | Ancestors poisoned | Would be honest otherwise |
| --- | --- | --- | --- |
| `inspectOfflineHost(root, cwd)` src/daemon/offline-doctor.ts:12-50 | Hard-wires `inspectHost(root)` :25 (PATH via `Bun.which`, Host config file, `access()` on root) and `discoverProject(cwd)` :27 (realpath + walk to `/`) inside a check-building policy function; neither provider nor its observations appear in the signature | none — the direct parent `createCliClient` (src/index.ts:47-62) is an `[O]` composition root, so propagation stops immediately | n/a (no poisoned ancestors). `createCliClient` is honest-shaped as an owner and would stay `[O]` after the fix. |

Owner contract defects (do not propagate by rule; listed so the caller can decide whether to promote any of them to `[D]`):

| [O] node | Defect | Nearest caller affected |
| --- | --- | --- |
| `readDaemonToken(root)` src/daemon/files.ts:57-71 | Every read failure and the empty-file case collapse into `DAEMON_MISSING` :64-70, unlike `readRecord` which separates ENOENT from `DAEMON_STATE` :25-30 | `connectDaemon` :16 -> `createCliClient.command` :56 chooses the offline doctor on this code |
| `DaemonClient.request(path, body, timeoutMs)` src/daemon/client.ts:72-112 | Timeout (`AbortSignal.timeout` :86) and refusal are both `DAEMON_UNREACHABLE` :89-95; deadlines are hard-coded per method :37,:47,:66 rather than caller-selected; no caller `AbortSignal` parameter | `createCliClient.command` :56 (doctor fallback on timeout); `runRigCli` cannot cancel an in-flight request through `dependencies.signal` |
| `createHostDiagnosticLog(options)` src/diagnostics/host-log.ts:8-21 | `readHostConfig` rejection silently selects default policy :16; no `{error}` or warning channel; no test file | `main` :23; the user sees only `rig doctor`'s separate `host-config` check |
| `createFileDiagnosticLog(...).record(entry)` src/diagnostics/file-log.ts:87-127 | Up to ~2 s of blocking in `acquireLock` :137-152 is not part of the stated `DiagnosticLog.record` contract (src/diagnostics/types.ts:18) | `recordDiagnostic` :33 -> every command start/finish in `runRigCli` :22,:47 |
| `inspectHost(root)` src/adapters/host-inspection.ts:7-86 | Fat: observation (`Bun.which` :43, `access` :61/:69, `readHostConfig` :10) and check policy (:16-26, :42-58) are one body; PATH is not derivable from `root` | `inspectOfflineHost` :25 (the `[D]` above); runtime side injects it as `deps.inspectHost` and is unaffected |

#### 3. Ledgers

##### 3.1 `inspectOfflineHost(root, cwd)` — src/daemon/offline-doctor.ts:12-50 `[D]`

| Field | Entry |
| --- | --- |
| Inputs | `root: string` (state root), `cwd: string` (request repoPath or captured cwd, chosen by `createCliClient` :57) |
| Outputs | `Promise<{ ok: false; checks: DoctorCheck[] }>`; always `ok: false` :49; first check is the literal `rigd` unreachable entry :17-23; no thrown failure (both adapter calls are caught or total) |
| Ambient access | via `inspectHost(root)` :25: `Bun.which("bun")`, `Bun.which("git")` (PATH env, host-inspection.ts:43), `readHostConfig(root)` (config.yaml/json under root, :10), `access(root)` and `access(dirname(root))` (:61,:69); via `discoverProject(cwd)` :27: `realpath(cwd)`, `stat`, and `locateConfig` reads walking from `cwd` up to `/` (documents.ts:180-198) |
| Prerequisites | none stated; `cwd` need not exist (a non-ENOENT/`ConfigError` failure becomes a `config-invalid` check :41) |
| Failure | Never throws. `missing_config` is suppressed :34; any other `ConfigError` or non-`ConfigError` becomes a failed `project-config` check :35-47 with message/hint copied from the error (safe by ConfigError's contract :1 "Context excludes config contents"). Response policy decided here. |
| Callees | `inspectHost(root)` — reads PATH, root config, root permissions; writes nothing; **t: runtime-side tests only** (runtime-application, runtime-review-regressions, zz-bughunt); no CLI-side unit test. `discoverProject(cwd)` — reads fs upward from cwd; **t: config tests (other reviewer)**. This function itself: **no direct test**; reached only through `createCliClient` in tests/daemon-connection.test.ts:46-48 (valid-config branch only). |
| Missing tests (review only) | (1) invalid project config -> `project-config` ok:false with the ConfigError hint (:35-47); (2) missing config -> no `project-config` check at all (:34); (3) non-existent `cwd` -> "Project discovery failed." (:41); (4) with the fix, a fake `inspectHost` returning a failing check to assert ordering `rigd` first (:16-25). Implementer test set: tests/daemon-connection.test.ts plus the new unit file. |

##### 3.2 Owner-defect ledgers (abridged, for the caller's tally)

`readDaemonToken(root)` files.ts:57-71 — Inputs: root. Outputs: token string | throws `DAEMON_MISSING`. Ambient: `readFile(join(root,"auth","control-plane.token"))`. Failure: one code for ENOENT, EACCES, EISDIR, and empty content. Callees: node fs. Missing test: unreadable-but-present token file asserting a distinct code (the sibling `readRecord` already models the distinction :25-30).

`DaemonClient.request(path, body, timeoutMs)` client.ts:72-112 — Inputs: receiver `address`, path, body, timeoutMs (chosen by `status`/`command`, not by the CLI). Outputs: parsed JSON | throws `DAEMON_UNREACHABLE` | `DAEMON_PROTOCOL` | daemon's own code. Ambient: global `fetch` :79, `AbortSignal.timeout` :86. Prerequisites: address/token fresh from `connectDaemon`. Failure: timeout and refusal collapsed :89-95. Missing test: a server that never responds within the deadline, asserting the code the CLI receives.

`createHostDiagnosticLog(options)` host-log.ts:8-21 — Inputs: root, source, now. Outputs: `DiagnosticLog`. Ambient: Host config under root (once, memoised :14). Failure: rejection swallowed :16. Missing test: invalid Host config -> `record` still succeeds and (if a channel is added) reports the fallback.

`createFileDiagnosticLog(options).record(entry)` file-log.ts:87-127 — Inputs: options (root, source, now, retentionDays?, level?), entry. Outputs: `{path}` | `{error}` | `{}`; appends to `logs/<source>/<source>.jsonl`, rotates and prunes. Ambient: fs, sqlite lock file, `setTimeout` :151. Prerequisites: none. Failure: returned as data :119. Blocking: up to 200 x 10 ms. Tested thoroughly (file-log.test.ts); only the blocking bound is undocumented.

#### 4. Concrete bugs noticed (separate from honesty)

1. **First Ctrl-C after submission is silently ignored; cancellation never reaches the transport.** `src/index.ts:13-16` aborts a controller on SIGINT, but `src/daemon/client.ts:86` only uses `AbortSignal.timeout` and `src/cli/rig.ts` checks `signal.aborted` only before the request (:29) and inside `followLogs` (:94,:96). Scenario: `rig up live` is waiting on rigd (deadline 300 s, client.ts:66); the user presses Ctrl-C once — nothing is printed, the CLI keeps waiting, then renders the result and exits 0 as if never cancelled. Because the listener is `process.once`, a second Ctrl-C kills the process with the default handler (no `command.failed` diagnostic). The "cancel only before submission" policy is deliberate (cli.test.ts:604-632), but the user gets no feedback that the first Ctrl-C was consumed. Correction: either print "rigd is still running the operation; press Ctrl-C again to detach" from the abort handler, or pass the signal through `DaemonClient` for read-only actions.

2. **Unreadable token is reported as "not installed", and `rig doctor` then claims the daemon is unreachable.** `src/daemon/files.ts:64-70` maps every failure to `DAEMON_MISSING`; `src/daemon/connection.ts:21-24` treats that as "unavailable"; `src/index.ts:56-57` falls back to `inspectOfflineHost`, whose first check says "The daemon is not reachable" / "Run rigd status, then rigd install if needed" (`src/daemon/offline-doctor.ts:17-23`). Scenario: `~/.rig/auth/control-plane.token` exists but is owned by another user (EACCES) while rigd is running. `rig up` says "rigd is not installed." and `rig doctor` says the daemon is unreachable; both hints lead the user to reinstall. Contrast `readRecord` :25-30, which already distinguishes `DAEMON_STATE`.

3. **A slow daemon is diagnosed as absent.** `src/daemon/client.ts:66` gives `doctor` a 5 s deadline and `:89-95` turns the timeout into `DAEMON_UNREACHABLE`, so `createCliClient.command` (`src/index.ts:56-57`) runs the offline doctor. Scenario: rigd is alive but takes more than 5 s to answer `doctor` (e.g. serialized behind a long mutation); the report says "The daemon is not reachable", `ok: false`, exit 1 (`src/cli/rig.ts:55-56`). Correction: distinguish `DAEMON_TIMEOUT` from refusal and do not fall back on timeout.

4. **Ctrl-C at an interactive prompt exits 1 with an error message, while Ctrl-C anywhere else exits 0 silently.** In raw mode readline emits the interface's own `SIGINT` (no process signal), so `src/adapters/terminal-interaction.ts:33` rejects with `CANCELLED` but `main`'s controller is never aborted. `src/cli/rig.ts:71-75` maps `CANCELLED` to exit 0 only when `dependencies.signal?.aborted` is true, so the error falls through to `reportFailure` :76-83 and the user sees "The operation was cancelled.\nNo runtime change was requested." with exit code 1. Correction: give `createTerminalInteraction` a `cancel()` callback (or abort the shared controller from the readline SIGINT), or treat `CANCELLED` as exit 0 unconditionally.

5. **`RIG_ROOT=""` selects the current directory as the rig root.** `src/cli/entry-environment.ts:6` uses `??`, so an empty string bypasses the `~/.rig` default and `resolve("")` yields `process.cwd()`. Scenario: a shell that exports `RIG_ROOT=` (empty) to disable an override makes `rig` create `logs/`, read `daemon/address.json`, etc. under whatever directory the user is in. Correction: treat empty as unset (`|| join(homedir(), ".rig")`) or reject with a usage error.

6. **(Latent) `--follow` replays the last page forever if a reply lacks a string cursor.** `src/cli/rig.ts:97-102` omits `after` when `cursor` is not a string and the reply is `unknown` and never validated (contrast `readReply` in `src/cli/interaction.ts:156-165`). Today's daemon always returns a cursor (`src/adapters/target-log-reader.ts:130-133`), so this only bites with a version-skewed or foreign daemon, in which case the same 50 lines are re-rendered every 250 ms. Correction: validate the logs reply with a local zod schema and fail with `DAEMON_PROTOCOL`.

7. **(Minor) Interactive read-only queries are uncorrelated and `command.completed` precedes the follow loop.** `prepareInteractiveRequest` runs before `newOperationId()` (`src/cli/rig.ts:19-20`), so its `status` / `initialization-info` / `deployment-context` requests carry no `operationId`; and `command.completed` is recorded at :47-53 before `followLogs` :57, so a failing follow records both `command.completed` and `command.failed` for one operation. Evidence quality only.

Policy duplication noticed (step 7, not bugs): the `CANCELLED` `RigError` literal is built in three places (`src/cli/rig.ts:30-34`, `src/cli/interaction.ts:148-154`, `src/adapters/terminal-interaction.ts:7-12`); and two terminal sanitizers diverge — `displayWord` (`src/cli/output.ts:132-136`) strips only 7-bit CSI and C0/DEL, leaving C1 controls (U+0080-U+009F) and bidi overrides (U+202A-U+202E) in `rig status` output, while `terminalText` (`src/cli/terminal-text.ts:3-8`) removes all of them for prompts.

## Appendix B — Daemon fragment

### Function-honesty tree: `rigd` daemon entry, composition, control plane, admin, runtime dispatch

Source at HEAD 470a510. Trust marks re-verified by running the ten listed test files
(`bun test` → 99 pass / 0 fail, 6.4s). Line numbers are from the current files.

Legend: `[H]` honest · `[D]` dishonest by own defect · `[T]` dishonest only by inheritance ·
`[D+T]` both · `[O]` effect owner by design (propagation stops). `t:` = test file(s) that
exercise the node through a public boundary (trusted); `t:-` = not directly tested.
"(other reviewer)" = classified at the boundary only.

#### 1. Call tree

```
main(args) [O entry] src/rigd.ts:10
  ↳ owner reads: rigRoot() :11, RIG_DAEMON_CHILD :16, RIG_ROOT→mode :26, homedir :27, randomUUID :30, Date :34
  rigRoot() [O] src/cli/entry-environment.ts:5                       (process.env, homedir)
  daemonCommand() [O] src/cli/entry-environment.ts:18                (process.argv, execPath, import.meta.dir)
  userOutput() [O] src/cli/entry-environment.ts:8                    (stdout/stderr)
  runCapturedProcess(requestPath) [O] src/providers/captured-process.ts:19   (other reviewer)
  createHostDiagnosticLog({root, source, now}) [O adapter] src/diagnostics/host-log.ts:8
    readHostConfig(root) [O fs] src/config/documents.ts:201          (config reviewer)
    createFileDiagnosticLog(options) [O adapter] src/diagnostics/file-log.ts:80   t:diagnostics via file-log.test
      diagnosticRecord(entry, source, timestamp) [H] src/diagnostics/file-log.ts:34
  composeDaemon(root, captureCommand) [O composition root] src/daemon/composition.ts:31   t:config-http-e2e (via rig-fixture)
    ↳ owner reads: process.getuid :45, process.env :55, Date :39,:60,:85,:102,:142, randomUUID :86,:103, setInterval :134
    ↳ fat: monitor-loop policy (:134-149: re-entrancy flag, 5 s cadence, error swallow) and diagnostic
      event mapping (:104-110) are policy inside the owner; both could be named honest functions.
    readHostConfig(root) [O fs] src/config/documents.ts:201
    createFileDiagnosticLog(...) [O adapter] src/diagnostics/file-log.ts:80
    createChildSupervisor / createLaunchdSupervisor / createTargetEffects / createArtifactInstaller /
      createCaddyRouter / createGitSourceStore / createTargetLifecycle   (providers/lifecycle reviewers; boundary only)
    new FileStateStore(root) [O fs adapter] src/runtime/state-store.ts:15   t:state
      read() [O] :22           (fs read + legacy probe; tagged LEGACY_STATE_PRESENT/STATE_READ/STATE_CORRUPT)
      update(change) [O] :64   (in-process queue, re-read, callback, schema.parse, tmp+rename)
    createAdminActivityJournal({root, now, id}) [O fs adapter] src/adapters/admin-activity.ts:52   t:activity-admin
      read() [O] :59
      append(input) [O] :87    (wx lock file :97; failure degraded to {warning})
    inspectHost(root) [O adapter] src/adapters/host-inspection.ts:7   t:- (through doctor in runtime-application)
      ↳ reads host config (fs), Bun.which (PATH), access(root) — all named by the adapter's doc comment :6
    createAdoptionGuard(root) [O adapter: fs→assertOwnershipReady()] src/migration/adoption.ts:192   t:migration*
      readLegacyAdoption(root) [O fs] src/migration/adoption.ts:136
        parseManifest(raw) [H] :128
        validateEvidence(manifest, evidence) [H] :203
    createProjectDocuments(root, run) [O adapter] src/adapters/project-documents.ts:22   t:project-registration, initialization-slug
      createProjectDiscovery(run) [O] src/git/project.ts:32   (reads process.env :33 — owner-level acquisition inside a factory)
      discover = discoverProject(startPath) [O fs] src/config/documents.ts:177
      read = readProjectConfig(repoPath) [O fs] src/config/documents.ts:163
      resolve = resolveTargetPlan(input) [H] src/config/resolve.ts (config reviewer)
      host() → readHostConfig(root) [O fs]
      initializationInfo(path) [O] :32 / identifyInitialization(path, command) [O] :45 / initialize(path, command) [O] :53
        inspectInitialization(path, command, discovery) [D] src/adapters/project-documents.ts:86
          ↳ cause: hidden fs read `readProjectConfig(repoPath)` :101 — not in the signature or the
            `discovery` provider; a test controlling `discovery` still hits the real filesystem for rig.yaml.
          ↳ fix: add `readConfig` to `ProjectDiscovery` (or pass the pre-read document). With that fix it
            would be [H]: inspectProjectLocation and projectSlug are honest.
          ↳ propagation stops at createProjectDocuments [O] (adapter owns the fs channel); createRuntime is not poisoned by this.
          inspectProjectLocation(path, discovery) [H] src/git/project.ts:95   t:project-discovery
          projectSlug(directory) [H] src/adapters/project-documents.ts:123
        ensureProjectGit(input, discovery) [H] src/git/project.ts:187   t:project-discovery
        initializeProjectConfig(repoPath, input) [O fs] src/config/documents.ts:208
      rename(project, name) [O] :67
        readProjectConfig [O fs]; renameRigRemote(input, run) [H] src/git/remotes.ts:79; editProjectConfig(input) [O fs] :286
    createDeploymentSources(store, run) [H] src/adapters/deployment-sources.ts:6   t:- (runtime-application through fakes)
      preflightDeployment(input, run) [H] src/git/preflight.ts:6   t:git-preflight
      store.prepare(request) → git-source-store (providers reviewer)
    createRuntimeFiles() [O adapter] src/adapters/runtime-files.ts:7   t:port-selection, runtime-application
      selectPorts(...) [O net] :11  → availablePort(preferred) [O net] :32   (contract documented at contracts.ts:68-77)
      logs = readTargetLogs(target, after, lines) [O fs] src/adapters/target-log-reader.ts:58
      destroyPreview / inspectPreviewDeletion [O fs] src/adapters/preview-storage.ts:10,23
    createRuntime(deps) [D+T] src/runtime/application.ts:49   t:runtime-application (+6 files)
      ↳ cause (own): observation timing is a hidden dependency. `observeTargets(state.targets, deps.observations)`
        at :88 (prepare-uninstall) and :114 (list) omit the 4th argument, so `timerObservationDeadline`
        (src/runtime/bounded-observations.ts:9-14, setTimeout) and the 2000 ms budget (status.ts:41)
        are chosen by omission. `RuntimeDependencies` (contracts.ts:89-120) has no timing capability, so
        a fully faked `deps` cannot control when a slow observation becomes "unknown"/TARGETS_RUNNING.
      ↳ fix: add `observation: { budgetMs; deadline: ObservationDeadline }` (or a `timing` capability) to
        RuntimeDependencies, wired from composeDaemon, and pass it at :88, :114 and into projectStatus,
        doctor, updateRegistration. With that fix createRuntime would still inherit from selectProject
        (latent cwd) and updateRegistration (argument mutation) until those are fixed too.
      ↳ inherits from: selectProject [D latent], registerProject [D latent], updateRegistration [D],
        doctor [D], projectStatus [D].
      status(selection) [T] :52
        ↳ would be honest if: selectProject (cwd) and projectStatus (deadline default) were fixed.
        selectProject(command, deps, false) [D latent] src/runtime/projects.ts:8
        projectStatus(project, targets, selection, deps) [D] src/runtime/project-status.ts:16   (status reviewer)
          ↳ cause: observeTargets(selected, deps.observations) :51 — default deadline; deps Pick has no timing.
          observeTargets(targets, effects, budgetMs=2000, deadline=timerObservationDeadline) [H] src/runtime/status.ts:38   t:runtime-status
            boundedObservations(jobs, budgetMs, deadline) [H] src/runtime/bounded-observations.ts:24
      command(command) [T] :525
        ↳ would be honest if: execute were honest (see below). Own contract is clean apart from the
          weak `Promise<unknown>` result (:33) — a usability gap, not a hidden dependency.
        execute(command) [D+T] :65
          ↳ cause (own): observeTargets default deadline at :88 and :114 (see createRuntime).
          ↳ inherits from: selectProject :56/:169, registerProject :156, updateRegistration :210,
            doctor :208, projectStatus (via status :168).
          deps.assertOwnershipReady() :79,:109 → adoption guard closure [O]
          observeTargets(state.targets, deps.observations) [H] :88, :114   (callee honest; the omission is the caller's)
          deps.readAdminActivity() :138 → journal.read [O]
          deps.documents.initializationInfo(repoPath) :153 [O adapter]
          registerProject(command, deps) [D latent] src/runtime/projects.ts:56   t:project-registration
            ↳ cause: `resolve(repoPath) !== resolve(identity.repoPath)` :78 — node `path.resolve` reads
              process.cwd() when either path is relative. state-schema.ts:75 (`repoPath: text`) and the
              `identity.repoPath` returned by documents do not require absolute paths. Latent: production
              discovery canonicalizes to absolute (git/project.ts:58-63), so only hand-edited state or a
              fake `documents` adapter reaches the cwd read.
            ↳ fix: enforce `isAbsolute` in state-schema (`text.refine(isAbsolute)`) and at the
              ProjectDocuments boundary, then compare with `path.normalize`/equality. With that fix [H].
            deps.documents.identifyInitialization / initialize [O adapter]
            assertRegistrationAvailable(projects, identity) [D latent] :114   (same `resolve` :121,:126)
          hostDoctor(deps, discoveryFailure) [H] src/runtime/doctor.ts:10
            inspectRuntimeHost(deps) [H] src/runtime/doctor.ts:38
          selectProject(command, deps, readConfig) [D latent] src/runtime/projects.ts:8   t:- (through runtime-application)
            ↳ cause: `resolve(project.repoPath) !== resolve(found.repoPath)` :46 (cwd, latent as above).
            ↳ fix: as registerProject. With that fix [H].
            deps.documents.discover / read [O adapter]
            assertIdentity(project, document) [H] :135
          deps.sources.currentBranch(repoPath) :186,:243,:287 [H adapter method]
          deps.documents.host() :195,:230,:286,:302,:317 [O adapter]
          doctor(project, targets, deps) [D] src/runtime/doctor.ts:59   (status reviewer)
            ↳ cause: observeTargets(targets.filter(...), deps.observations) :155 — default deadline.
          updateRegistration(command, project, targets, deps) [D] src/runtime/registration.ts:7   t:runtime-application (repoint only)
            ↳ cause 1: observeTargets(targets, deps.observations) :13 — default deadline (as above).
            ↳ cause 2: `project.name = command.newName` :75 mutates the caller-owned ProjectRecord and
              returns void; execute later reads the mutated name in `finish`/`record` (:463,:477,:493).
              The signature shows no output channel for this.
            ↳ fix: return `{ project: ProjectRecord }` (renamed copy) and have execute assign it; take
              the deadline from deps. With both fixes [H] (recordedPorts, deps.* are honest).
            observeTargets(...) [H] src/runtime/status.ts:38
            recordedPorts(components) [H] src/runtime/ports.ts:4
            deps.documents.rename / discover / resolve [O adapter]; deps.store.read/update [O adapter]
          targetName(command) [H] src/runtime/targets.ts:13
          deps.sources.resolve / preflight :291,:297,:305 [H adapter methods]
          assertDeploymentRecovered(previous) [H] src/runtime/deploy.ts:7
          planTarget(input, deps) [H at boundary] src/runtime/targets.ts:40   (all effects via deps.id/root/sources/files/documents/store/now)
          activateDeployment(candidate, previous, intent, deps) [boundary — deploy reviewer] src/runtime/deploy.ts:18
          deps.lifecycle.retire(previous, publish) :353,:381 [provider via deps — honest at boundary]
          deps.files.logs(target, after, lines) :267 [O adapter]
          stopForRecovery(target, deps) [boundary — deploy reviewer] src/runtime/deploy.ts:135
          deps.files.inspectPreviewDeletion / destroyPreview :370,:382 [O adapter]
          persistTarget(target, store) [H] src/runtime/targets.ts:181
          stopRecordedTarget(target, lifecycle) [H] src/runtime/stop.ts:7
          deps.lifecycle.up / down :427,:419 [provider via deps — honest at boundary]
          record(outcome, errorCode?, causes) [H] :455   (deps.store.update + deps.diagnostic; diagnostic throw swallowed :482)
          finish(outcome, extra) [H] :486
          diagnosticErrorCode(error) [H] src/domain/errors.ts:149 · diagnosticCauses(error) [H] :129
          missingTarget(name) [H] :576
      exclusive(operation) [H] :509      (queue is receiver state; deps.assertOwnershipReady explicit)
      drain() [H] :505
      reconcile() [H] :531               (deps.store/lifecycle/diagnostic/id only; failures → deps.diagnostic, swallowed :547,:567)
    createConfigEditor({resolveProject, documents, exclusive}) [H] src/daemon/config-editor.ts:156   t:config-control-plane, config-http-e2e
      configEditorRequestSchema [H] :51 · pathSupported(node, path) [H] :108 · describeFields(node, prefix) [H] :126
      getField(value, path) [H] :146 · children(node) [H] :105
      validateEditPath(path) [H] src/config/editor.ts:8
      (composition wires documents.read/preview/apply to fs functions [O] config/documents.ts:237,276,286)
    start() [O] src/daemon/composition.ts:131        (setInterval, Date; swallow at :145)
      runtime.reconcile() [H]
      runtime.exclusive(() => monitorRuntimeFailures({store, observations, now})) [H]
        monitorRuntimeFailures(options) [H] src/runtime/activity.ts:20   t:runtime-monitor* (deadline optional, default chosen here by the owner)
          boundedObservations(jobs, budgetMs, deadline) [H] src/runtime/bounded-observations.ts:24
    shutdown() [O] src/daemon/composition.ts:151
  runDaemonHost(options) [O] src/daemon/host.ts:17   t:daemon-admin, activity-admin, config-http-e2e
    ↳ owner reads: process.pid, randomUUID :31; SIGTERM/SIGINT :115-116; process.exitCode :108,:111; fs :21-91
    ↳ fat: lease-reclamation decision (:45-60: valid record + live pid → DAEMON_RUNNING, else reclaim) and
      instance-matched release (:67-76) are policy that could be honest functions taking (prior, pidAlive).
    ownerSchema [H] src/daemon/files.ts:6
    processExists(pid) [O] src/daemon/host.ts:125       (process.kill(pid, 0))
    readDaemonToken(root) [O fs] src/daemon/files.ts:57 (every failure → DAEMON_MISSING)
    startControlPlane(options) [O transport] src/daemon/server.ts:20   t:transport, config-http-e2e
      authenticated(request, token) [H] src/daemon/server.ts:13
      commandSchema [H] src/daemon/protocol.ts:4
      asRigError(error) [H] src/domain/errors.ts:22
      /health reads process.pid :53 (inside the owner; acceptable)
    release() [O] src/daemon/host.ts:67
    stop(exitCode) [O] src/daemon/host.ts:98
  runRigdCli(args, {admin, output, diagnostics, newOperationId}) [H] src/cli/rigd.ts:14   t:src/cli/rigd.test.ts
    ↳ every channel explicit; providers' effects are stated (DaemonAdmin is documented as the owner :47).
      Commander 15 consults NO_COLOR/FORCE_COLOR for help styling only (cosmetic; test asserts exit codes).
    terminalCommand(name, output) [H] src/cli/commands.ts
    recordDiagnostic(log, entry) [H] src/cli/failure.ts:33
    renderResult(action, value) [H] src/cli/output.ts:3
    isHelp(error) [H] src/cli/failure.ts:43 · reportFailure(error, input) [H] :51
  new DaemonAdmin({root, command, mode, userHome, uid?, stopTimeoutMs?, activity?}) [O adapter] src/daemon/admin.ts:48   t:daemon-admin, activity-admin
    ↳ owner reads: Date/randomUUID defaults :57-58, fs, net (DaemonClient), process.kill :227, Date.now :228,
      setTimeout (pause :39), process.env :269,:321, process.getuid :289,:326, Bun.spawn :300, Bun.hash :286
    ↳ fat: the reachability predicate (:85-90), install-record parsing (:191-209) and the stop-wait loop
      (:228-236) are policy inline in the owner; each could be an honest function.
    status() [O] :61
      readDaemonAddress(root) [O fs] src/daemon/files.ts:50 · readDaemonOwner(root) [O fs] :53 · readRecord(path, schema) [O fs] :17
      readDaemonToken(root) [O fs] :57
      processExists(pid) [O] src/daemon/host.ts:125
      DaemonClient.health() [O net] src/daemon/client.ts:35
    install(operationId?) :96 → recordAdministration(action, operationId, work) [O] :106 → performInstall() [O] :136
      spawnDetached() [O] :252 · installLaunchd() [O] :317 → launchctl(args) [O] :299
    uninstall(operationId?) :101 → recordAdministration → performUninstall() [O] :179
      DaemonClient.command({action:"prepare-uninstall"|"cancel-uninstall"}) [O net] src/daemon/client.ts:60
      launchctl / process.kill / pause
    label() [H] :285 · labelDomain() [O: getuid] :288 · plistPath() [H] :291 · xml(s) [H] :40 · pause(ms) [O] :39
```

#### 2. Propagation summary

| [D] node | cause | ancestors poisoned (up to owner) | which would be honest otherwise |
| --- | --- | --- | --- |
| `execute` / `createRuntime` — application.ts:88, :114 | `observeTargets` called without a deadline → real `setTimeout` via `timerObservationDeadline`; `RuntimeDependencies` has no timing capability | `command` :525 → `composeDaemon` [O] (stop) | `command` [T] would be honest; `createRuntime` has this as its own defect |
| `projectStatus` — project-status.ts:51 | same default-deadline omission (status reviewer owns depth) | `status` :52 → `createRuntime` → `composeDaemon` [O] | `status` [T] would be honest |
| `doctor` — doctor.ts:155 | same default-deadline omission | `execute` → `command` → `createRuntime` → `composeDaemon` [O] | `command` [T] |
| `updateRegistration` — registration.ts:13, :75 | (1) default-deadline omission; (2) mutates caller's `project.name` with a `void` return | `execute` → `command` → `createRuntime` → `composeDaemon` [O] | `command` [T] |
| `selectProject` — projects.ts:46 (latent) | `path.resolve` reads `process.cwd()` for relative `repoPath`; schema does not forbid relative paths | `status`, `execute` → `command` → `createRuntime` → `composeDaemon` [O] | `status`, `command` [T] |
| `registerProject` / `assertRegistrationAvailable` — projects.ts:78, :121, :126 (latent) | same `resolve`/cwd read | `execute` → `command` → `createRuntime` → `composeDaemon` [O] | `command` [T] |
| `inspectInitialization` — project-documents.ts:101 | hidden `readProjectConfig` fs read not covered by the `discovery` provider | `initializationInfo`/`identifyInitialization`/`initialize` → `createProjectDocuments` [O adapter] (stop) | none above it are non-owners; `createRuntime` is unaffected because `ProjectDocuments` is the declared fs boundary |

Nodes that would be honest with the single RuntimeDependencies timing fix: `execute`, `createRuntime` (own part), `projectStatus`, `doctor`, `updateRegistration` (cause 1). Remaining after that fix: `updateRegistration` cause 2, the latent cwd reads in `projects.ts`.

#### 3. Ledgers for [D] and [D+T] nodes

##### createRuntime(deps) / execute(command) — src/runtime/application.ts:49, :65 [D+T]
- Inputs: `RuntimeDependencies` (contracts.ts:89-120); `RuntimeCommand`; receiver state `queue`, `draining` (closure).
- Outputs: `Promise<unknown>` result envelope; `deps.store.update` (activity + target records); `deps.diagnostic` events; thrown tagged `RigError`/`ConfigError`.
- Ambient: `timerObservationDeadline.schedule → setTimeout` reached by omission at :88 and :114 (and via projectStatus :51, doctor :155, updateRegistration :13); `process.cwd()` latent via projects.ts `resolve`.
- Prerequisites: mutations serialized by `command` :527; `assertOwnershipReady` before non-read actions :79; `draining` gate :73.
- Failure: throws; non-read failures recorded to Activity then diagnostic :434-452; a throw from `deps.diagnostic` is swallowed (:448, :482) and the returned `{error}` is discarded by composition.ts:104-110 — policy not stated on `RuntimeDependencies.diagnostic`.
- Callees + trust: selectProject t:- (indirect), registerProject t:project-registration, updateRegistration t:runtime-application (repoint), doctor t:runtime-application, projectStatus t:runtime-application/transport, planTarget t:runtime-application, activateDeployment t:deployment-effects, stopForRecovery t:runtime-application, persistTarget, stopRecordedTarget t:runtime-application, observeTargets t:runtime-status, readTargetLogs t:runtime-logs, hostDoctor t:runtime-application.

##### updateRegistration(command, project, targets, deps) — src/runtime/registration.ts:7 [D]
- Inputs: command, caller-owned `project` and `targets`, deps (observations, store, documents).
- Outputs: `void`; `deps.store.update` (project name/path, target plans); `deps.documents.rename` (config + git remote); **mutates `project.name` :75**.
- Ambient: default observation deadline via observeTargets :13.
- Prerequisites: caller holds the mutation queue; every Target stopped (:14-26).
- Failure: PROJECT_ACTIVE, PROJECT_NAME, PROJECT_CONFLICT, PROJECT_PATH, PROJECT_IDENTITY, RENAME_ROLLBACK (:65) wrapping store failure + rollback failure.
- Callees: observeTargets [H] trusted; recordedPorts [H]; deps.documents.rename (adapter, t:- for rename path — only repoint is covered in runtime-application :225).

##### selectProject / registerProject / assertRegistrationAvailable — src/runtime/projects.ts:8, :56, :114 [D latent]
- Inputs: command, deps (store, documents, id, now).
- Outputs: `{project, document?}` / new `ProjectRecord`; `deps.store.update` push :101.
- Ambient: `process.cwd()` through `path.resolve` at :46, :78, :121, :126 when a `repoPath` is relative.
- Prerequisites: `repoPath` values absolute (not enforced by state-schema.ts:75 or contracts.ts:19-33).
- Failure: PROJECT_MISSING, PROJECT_REQUIRED, PROJECT_PATH_CONFLICT, PROJECT_IDENTITY, PROJECT_CONFLICT, PATH_REQUIRED, REGISTRATION_INCOMPLETE.
- Callees: deps.documents.discover/read/identifyInitialization/initialize (adapter), assertIdentity [H], deps.store [adapter]. Trust: project-registration.test (real documents adapter, absolute paths).

##### inspectInitialization(path, command, discovery) — src/adapters/project-documents.ts:86 [D]
- Inputs: path, command (createGit, project), `discovery` provider.
- Outputs: `{repoPath, name, existing, productionBranch, gitRequired}`.
- Ambient: `readProjectConfig(repoPath)` :101 — real fs read outside the provider.
- Prerequisites: none.
- Failure: GIT_REQUIRED :94, PROJECT_IDENTITY :109; ConfigError other than missing_config rethrown :103.
- Callees: inspectProjectLocation [H] t:project-discovery; readProjectConfig [O fs] t:config tests; projectSlug [H] t:initialization-slug.

#### 4. Concrete bugs noticed (separate from honesty)

1. **`src/daemon/admin.ts:149-156` — empty token file makes install fail with a raw `EEXIST`.** `readDaemonToken` throws `DAEMON_MISSING` for an existing-but-empty `auth/control-plane.token` (files.ts:62), so `performInstall` takes the catch branch and calls `writeFile(tokenPath, …, { flag: "wx" })`, which rejects with a Node `EEXIST` error (not a `RigError`, no hint). Scenario: a truncated/empty token file after a crash or manual edit; `rigd install` never self-heals. Fix: distinguish "absent" from "empty/unreadable" (files.ts collapses all three) and overwrite or report a tagged error.

2. **`src/daemon/admin.ts:137-138` — reachable daemon without an install marker returns `unchanged` and leaves it uninstallable.** If `daemon/install.json` is missing (marker deleted, or a daemon started by hand with `RIG_DAEMON_CHILD=1`) but the daemon is reachable, `performInstall` returns `{installed:false, reachable:true, outcome:"unchanged"}` without writing the marker. A later `uninstall` passes the "nothing installed" check (:182 requires all three false), reaches :193 and throws `DAEMON_INSTALL_STATE` — the healthy daemon cannot be uninstalled through the CLI. Fix: rewrite the marker when `reachable && !installed`.

3. **`src/adapters/admin-activity.ts:97, 114-117` — a stale `admin-activity.jsonl.lock` is never reclaimed.** The lock is created with `wx` and removed only in `finally`. After a SIGKILL/power loss between :97 and :116, every later `append` fails at `open(lockPath, "wx")`, is caught at :108, and silently returns the warning forever; all daemon-administration Activity is lost until someone deletes the file by hand. Fix: store the pid in the lock and reclaim when that pid is dead (as `runDaemonHost` does for `owner.json`), or use a kernel-released lock like `file-log.ts:132`.

4. **`src/daemon/host.ts:67-76` — `release()` throws on a corrupt or `null` `address.json`/`owner.json`.** `JSON.parse` failures (SyntaxError, no `code`) and `saved === null` (TypeError on `.instanceId`) are rethrown. On the startup failure path (:94) this replaces the original startup error; on `stop()` (:105) it forces `process.exitCode = 1` and leaves the lease behind even though this instance still owns it. Fix: treat unparsable records as "not ours" (skip) rather than rethrow.

5. **`src/daemon/composition.ts:145` — the failure monitor swallows every error with no diagnostic.** `monitorRuntimeFailures` rejections (including `DAEMON_DRAINING` from `exclusive`, `STATE_CORRUPT`, `ADOPTION_PENDING`) vanish. Contrast `reconcile` (:539-547, :558-567) which reports through `deps.diagnostic`. A persistently failing monitor is invisible in `logs/rigd/rigd.jsonl`. Fix: route the catch to `diagnostic.record({event:"monitor.failed", code})`, rate-limited.

6. **`src/runtime/application.ts:159-167 → :169` — `doctor` without `--project` discovers the repository twice.** When `discover(command.repoPath)` succeeds at :163, execution falls through to `selectProject` at :169 which calls `discover` again (:36). Not incorrect, but it doubles the git/fs work and means the two discoveries can disagree under concurrent edits. Low priority.

Tests I would add (review-only): (a) `createRuntime` with a fake `observations.process` that never resolves — assert `list`/`prepare-uninstall` outcome under an injected deadline once `RuntimeDependencies` gains one; (b) `updateRegistration` rename path end-to-end through `createRuntime` with a real `createProjectDocuments` (only repoint is covered today); (c) `DaemonAdmin.install()` with an empty token file and with a missing marker + reachable daemon; (d) `createAdminActivityJournal.append` with a pre-existing lock file; (e) `runDaemonHost` shutdown with a corrupt `address.json`.

## Appendix C — Runtime fragment

### Function-honesty tree — runtime orchestration and target-effects adapter

HEAD 470a510. Source review only. Roots are the `createRuntime` command branches
(`src/runtime/application.ts:49`). Governing tests listed in the task were run
together at HEAD: 166 pass / 0 fail (`bun test` over the 11 files, RIG_ROOT temp).

Marks: `[H]` honest · `[D]` own defect · `[T]` inherited only · `[D+T]` both ·
`[O]` effect owner by design · `[B]` boundary owned by another reviewer (projects/
registration/state-store/config/host-inspection/adoption/deployment-sources),
not assessed here beyond its call shape. Provider leaves carry `[O]`/`[D]` from a
quick read of their factory heads only; the providers reviewer owns the depth.

Where I stopped: `selectProject`/`registerProject` (`src/runtime/projects.ts`),
`updateRegistration` (`src/runtime/registration.ts`), `FileStateStore`
(`src/runtime/state-store.ts`), `createProjectDocuments`, `createDeploymentSources`,
`inspectHost`, `createAdoptionGuard`, and everything under `src/providers/*`.

#### 1. Call tree

```
createRuntime(deps: RuntimeDependencies) [O] src/runtime/application.ts:49
  ↳ owner note: command handler; every dependency is injected (deps.now/id/store/…), so its own
    surface is clean EXCEPT two internal observeTargets calls that take the default 2000 ms
    wall-clock deadline: prepare-uninstall :88 and list :114 (see [D] pattern below). FAT: the
    `execute` closure (:65-502) holds eight command branches, activity recording (:455-485) and
    reply shaping (:486-501) in one body; queue/draining are receiver state (:50-51, :505-530).
  execute(command) — closure of the owner :65
  status(selection) — closure of the owner :52
    selectProject(command, deps, false) [B] src/runtime/projects.ts
    deps.store.read() [B] src/runtime/state-store.ts
    projectStatus(project, targets, selection, deps) [D] src/runtime/project-status.ts:16
      ↳ cause: :51 calls observeTargets(selected, deps.observations) with no budget/deadline, so the
        production timer (bounded-observations.ts:9-14, setTimeout :11) is chosen inside a function
        whose signature (deps Pick :20-22) offers no way to control it. Minor severity; fix is to
        carry `deadline`/`budgetMs` in RuntimeDependencies (e.g. under `observations`) and pass
        them through :51. With that fix projectStatus is [H]; nothing else is inherited.
      targetName(command) [H] src/runtime/targets.ts:13
      deps.assertOwnershipReady() [B] src/migration/adoption.ts (createAdoptionGuard)
      asRigError(error) [H] src/domain/errors.ts:22
      observeTargets(targets, effects, budgetMs = 2000, deadline = timerObservationDeadline) [H] src/runtime/status.ts:38
        ↳ note: honest through its signature (tests/runtime-status.test.ts drives `deadline`);
          the default at :41-42 is a named owner, not a hidden read.
        boundedObservations(jobs, budgetMs, deadline) [H] src/runtime/bounded-observations.ts:24
          deadline.schedule(...) → timerObservationDeadline [O] bounded-observations.ts:9 (setTimeout :11)
        effects.artifact/persistent/process/health → createTargetEffects.observations [O] src/adapters/target-effects.ts:436
          process → supervisor(target).observe(key, signal) :437 → provider leaf (see providers)
          health → health(component, target, signal) :439 → [O] :142 (global fetch :150 / options.run :157)
          artifact :440 → exists :485, ownership.inspect :450 [O], readInstallReceipt :457 [O],
                          installer.observe :476 (provider); catch-all → "unknown" :477-479
          persistent :481 → exists(component.path) [O]
          ↳ contract gap: artifact (:440) and persistent (:481) drop the `signal` that
            ObservationEffects (status.ts:26-35) hands them; cancellation is by abandonment only.
        aggregate(components) [H] src/runtime/status.ts:140
      deps.documents.read(project.repoPath) [B] src/adapters/project-documents.ts
      configuredComponents(config, kind) [H] src/runtime/project-status.ts:103

  ── up ── application.ts:392-432 (missing-local branch :392-404, recovery gate :405-413, start :427-428)
    selectProject(command, deps, false) [B] :169
    deps.store.read() [B] :181
    targetName(command) [H] targets.ts:13   (:245)
    deps.documents.read(project.repoPath) [B] :395
    planTarget({ command, project, document }, deps) [H] src/runtime/targets.ts:40   (:402)
      ↳ note: honest (id :63, now :175-176, root :64 all via deps) but asks for the whole
        RuntimeDependencies while using documents/sources/store/files/id/now/root — step-4 width
        finding, not dishonesty. Re-reads inventory at :105 (second snapshot under the queue).
      targetName(command) [H] targets.ts:13
      deps.documents.host() [B] :69
      deps.sources.currentBranch(repoPath) [B] :76 → createDeploymentSources → createGitSourceStore [O] (default `run ?? runCommand` git-source-store.ts:24)
      deps.sources.prepare({...}) [B] :86
      deps.store.read() [B] :105
      recordedPorts(existing.plan.components) [H] src/runtime/ports.ts:4   (:146)
      deps.files.selectPorts({ requests, occupied, policy }) → createRuntimeFiles().selectPorts [O] src/adapters/runtime-files.ts:11
        ↳ owner note: contract documented at contracts.ts:68-77 (probe-then-release, no reservation).
        availablePort(preferred) [O] runtime-files.ts:32 (net.createServer :34, listen 127.0.0.1 :44)
      deps.documents.resolve({...}) [B] :165 (pure resolver per config reviewer)
    persistTarget(target, deps.store) [H] src/runtime/targets.ts:181   (:403, :431)
    deps.lifecycle.up(target) → createTargetLifecycle(effects, timing = readinessTiming).up(target, checkpoint?) [H] src/runtime/lifecycle.ts:141
      ↳ note: `timing` is controllable through the factory signature (tests/readiness-timing.test.ts);
        composition.ts:99 passes none, so production relies on the named default owner :76-81.
        TargetLifecycle (:47-67) and TargetEffects (:11-46) state almost no effects/failure codes
        (only health :34 is documented); the codes are pinned by tests, not by the interface.
      assertProviderProfile(target) [H] lifecycle.ts:353
      effects.supervisor(target) → createTargetEffects.supervisor [O] target-effects.ts:74 (map lookup on options.supervisors)
      effects.checkpoint(target) → createTargetEffects.checkpoint [O] target-effects.ts:216   (:151)
        superseded(previous, candidate) [H-in-owner] target-effects.ts:175
        transactions.checkpoint(targetId, artifacts) → createEffectTransactions.checkpoint [O] src/adapters/effect-transactions.ts:181
          load(targetId) [O] :87 → preparation.validateLayout [O] effect-preparation.ts:53
          options.ownership.inspect(artifact) → createArtifactOwnership.inspect [O] src/adapters/artifact-ownership.ts:53
          options.router.checkpoint(targetId) → createCaddyRouter [O] providers/caddy-router.ts:23 (default `run ?? runCommand` :31)
          preparation.begin(targetId) [O] effect-preparation.ts:95
          artifactRevision/copyFile/lstat/save→atomicFile [O] :223-231, artifact-ownership.ts:142/:171
          ↳ owner note: `active` Map (:81) makes captureArtifact/captureRoute (:256-277) history
            dependent — a no-op when no checkpoint was opened in this process. Accessor-hides-
            history pattern inside an owner; safe today because every lifecycle path opens a
            checkpoint first (lifecycle.ts:108, :151; deploy.ts:34).
      effects.prepare(target) [O] target-effects.ts:243   (:156)
        mkdir/open :244-255; options.run initdb :261-271 (POSTGRES_INIT :274); marker :282-287, :320-321;
        lockfile→installer policy :289-304 (undeclared policy); runTarget 600 000 ms :306-312
      effects.install(component, target) [O] target-effects.ts:340   (:161)
        ownership.inspect :348 [O]; environment :349 [O]; readInstallReceipt :357 [O]; options.installer.observe :360;
        digestFile :362; runTarget build :366-373 (BUILD_FAILED :375); ownership.publish :383 [O] → options.installer.install :384;
        writeInstallReceipt :391 [O]; transactions.captureArtifact :397 [O]
        options.installer → createArtifactInstaller [O] providers/artifact-installer.ts:29 (default `run ?? runCommand` :35)
      supervisor.observe(key) / ensureRunning({...}) / stop(key) → provider leaf   (:166, :181, :206)
        createChildSupervisor(options) [D] providers/child-supervisor.ts:56
          ↳ cause (boundary quick read): defaulted clock `options.now ?? (() => new Date())` :66 and
            defaulted inspection :67 are controllable, but stop timing reads Date.now() directly
            :212-219, bypassing the injected clock; setTimeout :250, randomUUID :299/:357, spawn :310.
            Propagation stops at createTargetEffects [O], which turns the supervisor into a parameter.
        createLaunchdSupervisor(options) [O] providers/launchd-supervisor.ts:31
          ↳ note: `run ?? runCommand` :32, `inspect ?? …` :33, `now ?? Date.now` :34 — all
            controllable through the signature; composition.ts:43-48 passes none.
      effects.hook(command, target, component?) [O] target-effects.ts:323   (:177, :180, :193, :197)
        runTarget → options.run [O] :98-115 (default 120 000 ms :103) → runCommand [O] providers/command-runner.ts:5 (spawn :20, setTimeout :39)
        recordOutput → mkdir :121, options.recordingTime :128, appendFile :136 [O]
      effects.environment(target, component) [O] target-effects.ts:86   (:186)
        readEnvironment(file) [O] :495 (readFile; ENV_FILE :503/:513)
      awaitReady(component, target, effects, timing) [H] lifecycle.ts:299
        timing.schedule(readyTimeout*1000, …) :310 / (100, …) :325 → readinessTiming [O] lifecycle.ts:76 (setTimeout :78)
        effects.health(component, target, signal) [O] target-effects.ts:142
          ↳ owner note: global `fetch` :150 is an undeclared client while `run` :157 is injected
            (2000 ms fixed :162); non-abort failures collapse to `false` :165-168 by the stated
            contract (lifecycle.ts:34).
      effects.route(target) [O] target-effects.ts:405 (router.remove :408 / apply :420; ROUTE_UPSTREAM :415; captureRoute :426)
      checkpoint.commit() [O] effect-transactions.ts:239 (removeCheckpoint failure swallowed :249-251)
      checkpoint.rollback() → rollback(journal) [O] effect-transactions.ts:116 (EFFECTS_COMMITTED :119, EFFECTS_CHANGED :151/:158, router.restore :174)
    finish(outcome) / record(...) — owner closures :486/:455 → deps.store.update [B], deps.diagnostic (composition)

  ── down ── application.ts:415-419 (recovery gate :405-413)
    stopForRecovery(target, deps) [H] src/runtime/deploy.ts:135   (:412)
      stopForTransition(target, deps.lifecycle) [H] lifecycle.ts:342 → lifecycle.down (below)
      deps.lifecycle.commitEffects(target) [H] lifecycle.ts:97 → effects.commitEffects [O] target-effects.ts:237 → transactions.commit [O] effect-transactions.ts:278
      deps.lifecycle.restoreEffects(target) [H] lifecycle.ts:93 → effects.restoreEffects [O] :238 → transactions.restore [O] :314 → rollback [O] :116 | preparation.recover [O] effect-preparation.ts:120 (randomUUID :139)
      persistTarget [H] targets.ts:181
    persistTarget(target, deps.store) [H]   (:418)
    stopRecordedTarget(target, deps.lifecycle) [H] src/runtime/stop.ts:7
      lifecycle.down(target) [H] lifecycle.ts:226
        assertProviderProfile [H] :353
        effects.supervisor(target) [O] :74; supervisor.observe :244 (failure swallowed by design :249-251); supervisor.stop :263 → provider leaves as above
        effects.hook (pre/post stop) [O] :255, :258, :270, :275
      lifecycle.restoreEffects(target) [H] :93 → [O] chain as above   (:16, :19)

  ── deploy / git-push ── application.ts:274-360
    deps.documents.host() [B] :286, :302, :317
    deps.sources.currentBranch / resolve / preflight [B] :287, :291, :297, :305
    assertDeploymentRecovered(target) [H] src/runtime/deploy.ts:7   (:307)
    planTarget({ command, project, document, existing: target }, deps) [H] targets.ts:40   (:337)
    activateDeployment(candidate, previous, { activation }, deps) [H] src/runtime/deploy.ts:18   (:346)
      ↳ note: all effects through deps.lifecycle/deps.store; failure channels DEPLOY_COMMIT_PENDING :69,
        DEPLOY_ROLLBACK_BLOCKED :96, DEPLOY_RESTORE_FAILED :115 keep closed causes via
        retainFailureCauses :42/:93/:112/:128 and failureCauses :74/:100/:119.
      assertDeploymentRecovered(previous) [H] :24
      deps.lifecycle.checkpoint(candidate, previous) [H] lifecycle.ts:89 → effects.checkpoint [O] target-effects.ts:216   (:34)
      persistTarget [H]   (:37, :60, :65, :91, :106, :110, :126)
      stopForTransition(previous | candidate, deps.lifecycle) [H] lifecycle.ts:342   (:48, :77, :78)
      deps.lifecycle.retireSuperseded(previous, candidate) [H] lifecycle.ts:101 → effects.retireSuperseded [O] target-effects.ts:241 → retireComponents [O] :186 (inspect :195, rm :201-202, captureArtifact :204)
      deps.lifecycle.up(candidate, checkpoint) [H] lifecycle.ts:141   (:52, :105)
      checkpoint.commit() / rollback() [O] effect-transactions.ts:239 / :116   (:62, :40, :79)
      retainFailureCauses / failureCauses [H] src/domain/errors.ts:60 / :118
    deps.lifecycle.retire(replacement, publishRemoval) [H] lifecycle.ts:106   (:353-357; see BUG 1)
      effects.checkpoint(target) [O] :108 → transactions.checkpoint [O]
      stopForTransition(target, lifecycle) [H] :111
      effects.removeRoute(target) [O] target-effects.ts:429 (router.remove :431; captureRoute :433)
      effects.retireArtifacts(target) [O] target-effects.ts:239 → retireComponents [O] :186
      publishRemoval() → deps.store.update [B]   (:114)
      checkpoint.commit() [O] :116 → RETIRE_COMMIT_PENDING :119 (drops caught cause — finding F3, re-verified)
      checkpoint.rollback() [O] :129; lifecycle.up(target) [H] :130 → RETIRE_ROLLBACK :133 (drops both causes)
    finish("deployed") — owner :359

  ── status ── application.ts:168 → status closure :52 (tree above)

  ── logs ── application.ts:262-273
    deps.files.logs(target, after, lines) → readTargetLogs(target, after, lines) [O] src/adapters/target-log-reader.ts:58
      ↳ owner note: read-only fs adapter; contract stated :54-57. Inputs are the record's logRoot
        and the opaque cursor; failures LOG_LIMIT :64, LOG_CURSOR :47, LOG_LINE_LIMIT :215, LOG_CORRUPT :248.
      decodeCursor(after, identity) [H] :135
      readSource(root, name, previous, recent) [O] :156 (open :164, stat :171, read :185)
      parseLine(name, line) [H] :222
      compareEntries(a, b) [H] :255 (Date.parse on stored strings; deterministic)

  ── doctor ── application.ts:159-167 (host-only) and :207-208 (project)
    hostDoctor(deps, discoveryFailure?) [H] src/runtime/doctor.ts:10
      inspectRuntimeHost(deps) [H] doctor.ts:38
        deps.inspectHost() [B] src/adapters/host-inspection.ts (composition.ts:91 binds root)
        deps.assertOwnershipReady() [B]
    doctor(project, targets, deps) [D] src/runtime/doctor.ts:59
      ↳ cause: :155-158 calls observeTargets(targets.filter(!recovery), deps.observations) with the
        default 2000 ms wall-clock deadline; `deps: RuntimeDependencies` (:62) offers no control.
        Same fix as projectStatus. With that fix doctor is [H] (its remaining issues are result-shape
        findings, not hidden dependencies): identity read :66 and per-Target re-read :112 (codex F2,
        re-verified); catch-alls :83-91 and :141-149 collapse every read/resolve failure into
        reason "config-invalid".
      inspectRuntimeHost(deps) [H] :64
      deps.documents.read(project.repoPath) [B] :66, :112
      deps.documents.resolve({...}) [B] :113
      recordedPorts(target.plan.components) [H] ports.ts:4   (:122)
      isDeepStrictEqual (node:util, pure) :124
      observeTargets(...) [H] status.ts:38   (:155)

  ── destroy ── application.ts:361-391
    stopForRecovery(target, deps) [H] deploy.ts:135   (:369)
    deps.files.inspectPreviewDeletion({ root, target, state }) → inspectPreviewDeletion [O] src/adapters/preview-storage.ts:23   (:370-374)
      deletionRoot(input) [O] :27 → inspectDeletionRoot [O] :42 (realpath :74, lstat :75-84, protected paths :92-106, verifyTree :108)
        within / overlaps / recordPaths [H] :112 / :121 / :124
        maybeStat / physicalPath / verifyTree [O] :148 / :157 / :172
    persistTarget(target, deps.store) [H]   (:378; desired "stopped" + destructionPending :375-377)
    deps.lifecycle.retire(target) [H] lifecycle.ts:106   (:381; no publishRemoval)
    deps.files.destroyPreview({ root, target, state }) → destroyPreview [O] preview-storage.ts:10 (rm :13; DESTROY_CLEANUP :16)   (:382-386)
    deps.store.update(remove target) [B]   (:387-389)
    finish("stopped") — owner :390 (destroy is recorded with outcome "stopped"; OperationRecord runtime.ts:46-56 has no "destroyed")

  ── reconcile ── application.ts:531-573 (owner method; queued, skips recovery/destructionPending :553)
    deps.assertOwnershipReady() [B] :537
    deps.store.read() [B] :550
    deps.lifecycle.up(target) [H] :555 / deps.lifecycle.down(target) [H] :556
    deps.diagnostic(...) — composition :539-547, :558-567

── reached from composition.ts:134-149, not from createRuntime ──
monitorRuntimeFailures({ store, observations, now, budgetMs?, deadline? }) [H] src/runtime/activity.ts:20
  ↳ note: same defaulted-deadline shape as observeTargets (:37-38); controllable through options,
    so honest; composition passes none (composition.ts:139-143).
  options.store.read/update [B]; boundedObservations [H]; options.observations.process → [O] target-effects.ts:437
```

##### Propagation, stated explicitly

Two `[D]` leaves live in my subtree; both are the same defect (an internal call
selects a wall-clock observation deadline that the enclosing signature cannot
control). Their only ancestor is `createRuntime`, which is the designated owner,
so nothing is `[T]`. The provider-boundary `[D]` (`createChildSupervisor`) is
absorbed by `createTargetEffects` `[O]`, which is the adapter that turns the
supervisor into a `TargetEffects` parameter; `createTargetLifecycle`,
`activateDeployment`, `stopRecordedTarget`, `stopForRecovery` and the `up`/`down`/
`deploy`/`destroy` branches therefore stay `[H]` with respect to it.

#### 2. Propagation summary

| [D] node | cause (file:line) | ancestors poisoned | which would be honest otherwise |
| --- | --- | --- | --- |
| `projectStatus` `src/runtime/project-status.ts:16` | :51 `observeTargets(selected, deps.observations)` takes the default `timerObservationDeadline` (`status.ts:41-42` → `bounded-observations.ts:9-11`); signature `deps` Pick (:20-22) cannot supply a deadline or budget | none below the owner; parent is `createRuntime.status` (:52) inside `[O]` | `projectStatus` itself would be `[H]` once `deadline`/`budgetMs` are threaded from `RuntimeDependencies` — its callees `observeTargets`, `boundedObservations`, `targetName`, `configuredComponents`, `asRigError` are all `[H]` |
| `doctor` `src/runtime/doctor.ts:59` | :155-158 same default deadline; `deps: RuntimeDependencies` (:62) has no deadline field | none; parent is the `doctor` branch (:207-208) inside `[O]` | `doctor` would be `[H]` with the same fix; its result-shape issues (F2 re-read :66/:112, catch-alls :83-91/:141-149) are step-5 findings, not hidden dependencies |
| `createRuntime` own leak (owner, not counted as a [D] node) `src/runtime/application.ts:88, :114` | `observeTargets(state.targets, deps.observations)` in `prepare-uninstall` and `list` — same default | — (owner) | fat-owner note; same fix |
| `createChildSupervisor` `src/providers/child-supervisor.ts:56` (boundary quick read) | `Date.now()` at :212-219 bypasses the injected `now` (:66); `setTimeout` :250; `randomUUID` :299/:357 | none in this subtree: `createTargetEffects` `[O]` (`target-effects.ts:57`) absorbs it | providers reviewer owns the fix; every runtime caller above the adapter is honest against the `Supervisor` interface |

#### 3. Ledgers for [D] nodes

##### `projectStatus(project, targets, command, deps)` — `src/runtime/project-status.ts:16`
- Inputs: `project` (name, repoPath), `targets` snapshot, `StatusSelection`, `deps` = `assertOwnershipReady`, `observations`, `documents.read`.
- Outputs: materialized `ProjectStatusReport` (targets, warnings); no writes; mutates only its own `reports` array (:76, :80, :91-96).
- Ambient: the 2000 ms `setTimeout` deadline reached through `observeTargets` defaults (:51 → `status.ts:41-42` → `bounded-observations.ts:11`). Everything else is via `deps`.
- Prerequisites: caller filtered `targets` to the project (application.ts:60); `reports.find(...)!` at :90 relies on every selected target having a report (true: observeTargets returns one per input, the ownership-failure path maps every selected target).
- Failure: ownership failure and config read failure become warnings (:32-35, :61-64); identity drift hides the document (:55-60); provider rejection/expiry surface as component state "unknown" with a reason (status.ts:118-126). No throw path except from `targetName` (PREVIEW_NAME/PREVIEW_REQUIRED).
- Callees + trust: `observeTargets` t:runtime-status (trusted); `boundedObservations` t:runtime-status (trusted); `targetName` t:runtime-application (trusted); `configuredComponents` t:runtime-application:273 (trusted); `deps.documents.read` [B] t:config suites; `deps.observations.*` → target-effects observations (untested at the adapter level for `artifact`/`persistent`; trusted only through runtime-application e2e).
- Change: add `observations: { …, deadline: ObservationDeadline, budgetMs: number }` (or a sibling `timing`) to `RuntimeDependencies` (`contracts.ts:106`), set it in `composeDaemon` (`composition.ts:100`), and pass it at :51. Then `[H]`.

##### `doctor(project, targets, deps)` — `src/runtime/doctor.ts:59`
- Inputs: `ProjectRecord`, project `TargetRecord[]`, full `RuntimeDependencies` (uses `inspectHost`, `assertOwnershipReady`, `documents.read/resolve`, `observations`).
- Outputs: `{ ok, checks[] }` materialized; no writes.
- Ambient: same default deadline via :155-158. `isDeepStrictEqual` is pure.
- Prerequisites: none beyond a project-filtered `targets`; each per-target read at :112 is an independent document acquisition (F2: identity at :66 and drift per target at :112 may see different revisions).
- Failure: every read/resolve failure becomes `reason: "config-invalid"` (:83-91, :141-149) — distinction between "missing", "invalid", and "resolve threw" is collapsed; ownership failure becomes a check (:46-55) and suppresses observation (:151-159).
- Callees + trust: `inspectRuntimeHost` t:runtime-review-regressions:83,105 (trusted); `observeTargets` t:runtime-status (trusted); `recordedPorts` t:runtime-application:225 (trusted); `deps.documents.resolve` [B] (config reviewer: honest resolver); `deps.inspectHost` [B].
- Change: same deadline threading as above → `[H]`. Independently (step 5/6): read the document once and reuse it for identity + drift; keep distinct reasons for read vs resolve failure.

#### 4. Concrete bugs noticed (separate from honesty)

1. **Preview replacement is never retried after a retirement failure, and a successful deploy is reported as failed.** `src/runtime/application.ts:346-358`: `activateDeployment` commits and returns the new Preview at :346-351 (`target` reassigned), then `deps.lifecycle.retire(replacement, …)` runs at :353. If `retire` throws (e.g. `STOP_INCOMPLETE` from `stopForTransition` at `lifecycle.ts:111`, or `RETIRE_ROLLBACK`/`RETIRE_COMMIT_PENDING` at :133/:119), the whole command rejects: the operation is recorded `failed` (:434-438) and the client sees an error naming the *new* target, although that Preview is committed and running. On the next `deploy` of the same branch the record exists with the same commit, so :308-314 returns `unchanged`; the replacement selection at :316 requires `!target`, so the oldest Preview is never retired again and the Project silently exceeds `deploy.generated.maxActive` (`config/schema.ts:290-299`) until someone runs `destroy`. No test exercises `maxActive`/`replacePolicy` (grep over `tests/` is empty). Scenario: `maxActive: 1`, `replacePolicy: "oldest"`, two previews, the oldest preview's process refuses SIGTERM/SIGKILL within the supervisor's stop window.

2. **Destroy outcome is indistinguishable from down in Activity.** `src/runtime/application.ts:390` records `finish("stopped")` for `destroy`; `OperationRecord.outcome` (`src/domain/runtime.ts:46-56`) has no `destroyed` member, so host Activity cannot show that bytes were deleted. Minor, but it is a lost distinction a reader of Activity acts on.

Contract-level findings (not bugs, kept separate as the task asked): `observations.artifact`/`persistent` ignore the abort `signal` (`target-effects.ts:440, :481`) although `ObservationEffects` (`status.ts:26-35`) supplies one; `retire` drops the caught causes when it rewraps (`lifecycle.ts:117-127, :131-137`) whereas `activateDeployment` preserves them (codex F3, re-verified at HEAD); `observations.artifact` swallows `INSTALL_RECEIPT` corruption and every non-ENOENT fs error into `"unknown"` (`target-effects.ts:477-479`), so doctor prints "Component is unknown" with a generic hint; `createTargetEffects.health` uses global `fetch` (:150) while `run` is injected — the adapter is an owner, but swapping the HTTP client changes the adapter body rather than its options.

#### 5. Tests I would add (review-only)

- `projectStatus`/`doctor` with a `controlledDeadline()` supplied through `deps` (impossible today — this test is what the [D] fix enables): expire before a slow `observations.process` resolves; assert `"unknown"` with the deadline reason and that no timer remains pending.
- Preview replacement (`tests/runtime-application.test.ts`): `maxActive: 1`, second preview deploy → assert the oldest is retired and inventory has one preview; then inject `retire` failure and assert the response outcome/target and that a retry (or a later reconcile) still retires the oldest.
- `observations.artifact` with a corrupt receipt: assert the distinct state or reason rather than bare `"unknown"`.
- `lifecycle.retire` with a classified commit failure and a classified rollback failure: assert `causes.primaryCause`/`recoveryCause` in the diagnostic event.
- `doctor` with a `documents.read` that returns different revisions on successive calls: assert one read and one coherent comparison.

Test set for the implementer of the deadline fix: `tests/runtime-status.test.ts`, `tests/runtime-application.test.ts`, `tests/runtime-review-regressions.test.ts`, `tests/deployment-e2e.test.ts`.

## Appendix D — Providers, git, config, migration fragment

### Function-honesty tree — providers / git-remote-rig / config / migration

Repo `/Users/clay/Projects/github/b-relay/rig` @ 470a510. Source review only.
Test baseline for trust marks (run with `RIG_ROOT=$(mktemp -d)`):
tests/providers-*.test.ts, tests/git-*.test.ts, tests/project-discovery.test.ts,
tests/config*.test.ts, tests/migration*.test.ts, tests/effect-preparation.test.ts,
tests/initialization-slug.test.ts → **142 pass / 0 fail across 22 files** (27.5 s).

Legend: `[H]` honest · `[D]` dishonest by own defect · `[T]` dishonest by
inheritance only · `[D+T]` both · `[O]` effect owner by design (propagation
stops; "fat" = owns more than one concern) · `[B]` boundary owned by another
fragment (tree-cli / tree-daemon / tree-runtime) · `t:` tests that exercise the
node (`t:-` = no direct test). "Given X" on an `[H]` method means: honest because
X was received through the factory options/parameters; if X was *defaulted* the
dishonesty sits at the factory, not the method.

Judgement rules applied (from function-design SKILL + contracts-and-effects):
- A factory that defaults ambient capabilities (`run ?? runCommand`,
  `now ?? Date.now`, `inspection ?? createProcessInspection()`) is `[D]` when
  called without those options. Returned methods are judged only on whether they
  use declared/received capabilities.
- Fixed internal sleeps, `Date.now`, `process.kill`, `setTimeout`, `Bun.which`,
  `process.env`, `process.cwd` (via `resolve()` on relative input) inside a
  function that did not declare them are `[D]`.
- `randomUUID()` used purely to name a temp file that is renamed/removed before
  return is **not** counted (no observable behaviour depends on it). Filesystem
  I/O under a path the function received (`stateRoot`, `request.logRoot`,
  `requestPath`, `repoPath`) is the declared purpose and not counted.
- Dishonesty propagates upward to, but not including, the nearest `[O]`.

---

#### 1. Call trees

##### A. Providers (rooted at composeDaemon)

```
composeDaemon(root, captureCommand) [O fat] src/daemon/composition.ts:31   [B tree-daemon]
  ↳ owner defects (no propagation, but these are the un-overridden defaults that make every
    provider factory below [D]):
      child     :42     no now / processInspection / stopTimeoutMs / restart*
      launchd   :43-48  no run / inspect / now;  domain uses process.getuid?.() ?? 501 :45
      installer :64     createArtifactInstaller() — no run / bunExecutable
      caddy     :65-79  no run / executable
      store     :96     createGitSourceStore({ root }) — no run
      run       :63     runCommand passed explicitly (honest hand-off to [O])
  createChildSupervisor({ stateRoot, captureCommand }) [D+T] src/providers/child-supervisor.ts:56
    t: providers-process.test.ts (defaults + restartLimit/BackoffMs :215-219, captureCommand :354-357),
       providers-process-stop.test.ts (injects processInspection :29-34), providers-capture.test.ts (via wrapper)
    ↳ cause: defaults `now = () => new Date()` :66 and `inspection = createProcessInspection()` :67
      (which in turn defaults run/kill); composition.ts:42 passes neither
    ↳ fix: require `now` + `processInspection` (or have composeDaemon pass them) → still [T]
      via observe/stop/scheduleRestart/waitForCaptureStart below
    createProcessInspection() [D] src/providers/process-inspection.ts:29   t: providers-process-stop.test.ts:29 (injected), providers-process.test.ts (defaulted)
      ↳ cause: `run ?? runCommand` :32, `kill ?? process.kill` :33-35 defaulted
      ↳ fix: require run/kill → [H] (all three members use only received capabilities)
      groupExists(pid) [H given kill/run] :36   (EPERM → `/bin/ps -g` via run :43-46; PROCESS_INSPECT :53)
      signalGroup(pid, signal) [H given kill] :61   (PROCESS_SIGNAL :71; calls groupExists on EPERM :68)
      createProcessIdentityReader(run) [H given run] src/providers/process-identity.ts:9   (:79)
      runCommand(request) [O] src/providers/command-runner.ts:5   (default; spawn :20, process.kill(-pid) :33, setTimeout :39)
    serialized(key, work) [H] :76
    recover(key) [H] :88   (lease under stateRoot :93; uses received inspect :106; PROCESS_LEASE :100)
    observe(key, signal?) [D] :118   t: providers-process.test.ts, providers-process-stop.test.ts
      ↳ cause: `process.kill(owned.pid, 0)` :149 — direct OS probe bypassing `inspection`;
        EPERM falls to "unknown" with no `ps` fallback, and a fake `processInspection` in tests
        still touches the real OS here
      ↳ fix: `await inspection.groupExists(owned.pid)` (or add `inspection.exists(pid)`) → [H]
      recover(key) [H] :88
      inspect(pid) [H given run] :167
    stop(key) [D] :177   t: providers-process-stop.test.ts, providers-process.test.ts
      ↳ cause: `Date.now()` :212,:214,:218,:219 and `Bun.sleep(20)` :215,:220 even though `now`
        was received; hidden deadlines 4000/1500 :213 (only partly covered by stopTimeoutMs) and
        1500 :218 (not configurable at all)
      ↳ fix: derive deadlines from `now()`, accept `sleep` (or `killTimeoutMs`) in options → [H]
      inspect(pid) [H given run] :203
      inspection.signalGroup [H given kill] :210,:217
      inspection.groupExists [H given kill/run] :214,:216,:219,:221
    scheduleRestart(request, exitCode) [D] :235   t: providers-process.test.ts (restart budget :215)
      ↳ cause: `setTimeout` :250 — timer channel undeclared (uses received `now()` :244 correctly;
        60_000/5/100 :246,:248,:264 are documented option defaults)
      ↳ fix: accept a `schedule`/timer capability → [T] via ensureRunning re-entry :253
      ensureRunning(request) :253   (re-entry)
    ensureRunning(request) [T] :269   t: providers-process.test.ts, providers-capture.test.ts
      ↳ would be honest if: observe [D] (:272), waitForCaptureStart [D] (:374), stop [D]
        (:376 stop-on-failure), scheduleRestart [D] (via captureOutput exit path)
      (spawn :310 is the declared purpose; mkdir/appendFile :290-292 under request.logRoot; randomUUID
       :299,:357 temp names — not counted)
      observe(key) :272
      clearCaptureStatus(requestPath) [H] src/providers/capture-status.ts:18
      captureOutput(owned, request, now) [H] :397   (appendFile under logRoot :417; 1 MiB flush :434)
        → scheduleRestart(request, exitCode)
      inspect(pid) [H given run] :355
      waitForCaptureStart(requestPath, timeoutMs = 5000) [D] src/providers/capture-status.ts:35   t:- (indirect via providers-process :354, providers-capture)
        ↳ cause: `Date.now()` :39,:40 and `Bun.sleep(20)` :57 with no clock/sleep parameter
        ↳ fix: accept `{ now, sleep }` (pass supervisor's `now`) → [H]
      stop(key) :376
    shutdown() [T] :386
      ↳ would be honest if: stop [D]
  createLaunchdSupervisor({ root, domain, labelPrefix, captureCommand }) [D+T] src/providers/launchd-supervisor.ts:31
    t: providers-launchd.test.ts (injects run :30-35; real launchd :74-79), providers-launchd-observation.test.ts (injects inspect/now/run :104-108)
    ↳ cause: defaults `run = runCommand` :32, `inspect = createProcessIdentityReader(run)` :33,
      `now = Date.now` :34; composition.ts:43-48 passes none
    ↳ fix: require run/inspect/now → still [T] via waitForApplication/stop/waitForCaptureStart
    createProcessIdentityReader(run) [H given run] src/providers/process-identity.ts:9   (:33; run itself defaulted)
    checked(args) [H given run] :38   (LAUNCHD_FAILED :41-46, raw stderr in details :45)
    observe(key, signal?) [H given run/inspect/now] :49   t: providers-launchd-observation.test.ts
      readCaptureObservation({ requestPath, wrapperPid, inspect, now, signal }) [H] src/providers/capture-observation.ts:47   t:- (indirect only)
        (readFile on declared requestPath :61; identity :63-72; freshness `age<0||age>1000` :74; catch-all → unknown :76)
    waitForApplication(key) [D] :87   t: providers-launchd.test.ts:74 (real), :30 (fake run)
      ↳ cause: `Bun.sleep(100)` × 30 :88-91 — 3 s of wall clock not derived from `now`, not injectable
      ↳ fix: accept `sleep` (or poll budget expressed through the injected clock) → [H]
      observe(key) :89
    ensureRunning(request) [T] :102
      ↳ would be honest if: waitForApplication [D] (:107,:153), waitForCaptureStart [D] (:147)
      (mkdir :115-116 under options.root/request.logRoot, writeFile :122,:126 under options.root, run :138, checked :143-144,:149 — declared)
      observe(key) :103
      clearCaptureStatus(requestPath) [H] capture-status.ts:18   (:121)
      launchdPlist(request, label) [H] :206   → xml(text) [H] :198
      checked(["bootout"|"bootstrap", …]) :143,:144,:149
      waitForCaptureStart(requestPath) [D] capture-status.ts:35   (:147)
      waitForApplication(key) [D] :87   (:107,:153)
    stop(key) [D] :155   t: providers-launchd.test.ts
      ↳ cause: `Bun.sleep(100)` × 30 :171-184 — fixed 3 s unload budget, uninjectable
      ↳ fix: accept `sleep` / poll budget option → [H]
      run(launchctl print) :156,:172 ; checked(["bootout"]) :170 ; rm plist/json under options.root :180-181
    shutdown() [H] :193   (no-op by design)
  createArtifactInstaller(options) [H] src/providers/artifact-installer.ts:29   t: providers-installer.test.ts (explicit run + bunExecutable)
    ↳ FIXED #229: `run` and `bunExecutable` are required; composition.ts passes runCommand and process.execPath
    install(request) [H given run, bunExecutable] :36
      ↳ FIXED #229: the shim always names `bunExecutable`; no `Bun.which`, BUN_MISSING removed
      run(/bin/sh -c build, 600_000) :39-44 [H given run]   (BUILD_FAILED :46)
      stat/mkdir/copyFile/chmod/rename under request.destination :54-82 — declared
    observe(path) [H] :88   (stat :90, access X_OK :92; ENOENT/EACCES → "missing" :95-98)
    shellQuote(arg) [H] :105 ; isSourceEntrypoint(path) [H] :109
  createCaddyRouter({ caddyfile, reload, extraConfig, reloadCommand? }) [D] src/providers/caddy-router.ts:23   t: providers-caddy.test.ts (injects run)
    ↳ cause: `run ?? runCommand` :31 defaulted; composition.ts:65-79 passes no run/executable
      (`executable ?? "caddy"` :91 is a documented default resolved by `run`, not counted)
    ↳ fix: require run → [H] (all methods use only received run + declared caddyfile)
    change(key, route?, restoration?) [H given run] :33   (ROUTE_INVALID :47, ROUTE_CHANGED :63, ROUTE_CONFLICT :73,
        validate :102-111 ROUTE_VALIDATE :113, `.rig-backup` :119, reload :122-128, rollback :130-134, ROUTE_RELOAD :135)
    serialized(work) [H] :152 ; checkpoint(key) [H] :160 ; restore(saved, expected) [H] :168
    hostnamePresent [H] :177 ; routeMarkers [H] :192 ; ownedBlock [H] :198 (ROUTE_CORRUPT :203)
  createGitSourceStore({ root }) [D+T] src/providers/git-source-store.ts:20   t: providers-git.test.ts:30-32,:65-67,:110-112 (injects run)
    ↳ cause: `run ?? runCommand` :24 defaulted; composition.ts:96 passes only root
    ↳ fix: require run → still [T] via prepare
    git(args, cwd?) [H given run] :26   (GIT_FAILED :29-34, raw stderr in details :33)
    prepare(request) [D] :37   (queued per project :108-120)
      ↳ cause: `resolve(request.repository)` :70,:85 and `resolve(request.destination)` :103 —
        resolution against `process.cwd()` when a caller passes a relative path; cwd is not a parameter
      ↳ fix: validate `isAbsolute(...)` at the boundary (GIT_REF-style error) or accept `cwd` → [H]
      exists(path) [H] :122 ; mkdir/rename/rm under options.root :60-88 — declared
  runCommand(request) [O] src/providers/command-runner.ts:5   (passed explicitly at composition.ts:63)

runCapturedProcess(requestPath) [O fat] src/providers/captured-process.ts:19   t: providers-capture.test.ts:30,:68 (real wrapper processes)
  (second root of subtree A: the `captureCommand` launched by launchd plists; owns signal handlers,
   the wrapper's lifetime, and the status/observation protocol)
  ↳ owner defects (no propagation): `createChildSupervisor({ stateRoot })` :23 with every default;
    `createProcessIdentityReader()` :32 with default run; `process.on` :28-30 / `process.pid` :33,:55;
    `Date.now()` :48; `Bun.sleep(50)` :64; catch-all :68-73 (see BUG-5)
  createChildSupervisor({ stateRoot }) [D+T] child-supervisor.ts:56   (same subtree as above)
  createProcessIdentityReader() [D] src/providers/process-identity.ts:9   t: providers-launchd-observation.test.ts:16 (real)
    ↳ cause: `run = runCommand` default parameter :10 (here called with no argument :32)
    ↳ fix: require run → [H]
    (returned reader) (pid) [H given run] :11   (`ps -p pid -o lstart=` :14, fixed env :16, PROCESS_INSPECT :21, sha256 :29)
  writeCaptureStatus(requestPath, status) [H] capture-status.ts:21   (:43,:69; tmp+rename)
  writeCaptureObservation(requestPath, evidence) [H] capture-observation.ts:32   (:54; tmp+rename)
  supervisor.ensureRunning / observe / stop / shutdown  — as marked above
```

Propagation, subtree A (leaf → owner):
- `observe [D] :149` → `ensureRunning [T] :272` → `createChildSupervisor [D+T]` → **composeDaemon [O]** (fails to override `processInspection`, `now`).
- `stop [D] :212-220` → `ensureRunning [T] :376`, `shutdown [T]` → `createChildSupervisor [D+T]` → composeDaemon [O] (fails to override `now`, `stopTimeoutMs`).
- `scheduleRestart [D] :250` → `captureOutput`→`ensureRunning [T]` → `createChildSupervisor [D+T]` → composeDaemon [O].
- `waitForCaptureStart [D] :39-57` → child `ensureRunning [T] :374` and launchd `ensureRunning [T] :147` → both factories `[D+T]` → composeDaemon [O].
- `createProcessInspection [D] :32-35` → `createChildSupervisor [D+T] :67` → composeDaemon [O] (fails to override `processInspection`).
- `waitForApplication [D] :91` → launchd `ensureRunning [T] :107,:153` → `createLaunchdSupervisor [D+T]` → composeDaemon [O] (fails to override `run`, `inspect`, `now`).
- launchd `stop [D] :184` → `createLaunchdSupervisor [D+T]` → composeDaemon [O].
- ~~`install [D] :66` → `createArtifactInstaller [D+T]` → composeDaemon [O] (fails to override `run`, `bunExecutable`).~~ FIXED #229.
- `createCaddyRouter [D] :31` → composeDaemon [O] (fails to override `run`, `executable`).
- store `prepare [D] :70,:85,:103` → `createGitSourceStore [D+T]` → `createDeploymentSources [T]` (tree B; it forwards `store.prepare` :22) → composeDaemon [O] (fails to override `run`).
- Same child-supervisor chain also terminates at `runCapturedProcess [O]` (:23) — which additionally fails to override everything.

##### B. git-remote-rig and the git/adapters boundary

```
main(args) [O fat] src/git/remote-helper.ts:310   t: git-remote-helper.test.ts (runRemoteHelper only), git-push.test.ts (real git, real runCommand)
  ↳ owner (process entrypoint): userOutput() :311, process.cwd() :325, rigRoot() :328, process.stdin :331,
    randomUUID :333, `new Date()` :338, connectDaemon(root) :341-343; propagation stops here
  inspectProjectGit(process.cwd(), discovery) [H] src/git/project.ts:169   t: git-project.test.ts, project-discovery.test.ts
    (GIT_REQUIRED :178; honest through the `discovery` parameter)
    inspectProjectLocation(path, discovery) [H] :95   (GIT_BARE :106, "not a git repository" :114, init.defaultBranch :116-128,
        show-toplevel :131-138, origin/HEAD :139-152, HEAD :154-166)
      canonicalPath(path, discovery) [H] :41   (GIT_PATH_MISSING/UNREADABLE :50-56)
      readGit(cwd, args, discovery) [H] :75 ; branchValue [H] :87 ; discoveryFailure [H] :67
  createProjectDiscovery(runCommand) [D] src/git/project.ts:32   t: git-project.test.ts:274,:327, project-discovery.test.ts (fake discovery :12-13)
    ↳ cause: reads `process.env` inside the factory :33 and bakes it into `run` :36-37 (LC_ALL=C); the
      environment that shapes every git invocation is not a parameter
    ↳ fix: `createProjectDiscovery(run, env)` (composeDaemon already builds a filtered `environment` :54-58) → [H]
    canonicalize = realpath :35 (declared purpose)
  runCommand [O] command-runner.ts:5   (passed explicitly :327,:334)
  createGitPushSource(repoPath, runCommand) [H] remote-helper.ts:264   t: git-push.test.ts (real git)
    resolve(ref) [H] :269   (GIT_REF :270-292) ; verifyBranch(branch) [H] :294   (GIT_BRANCH :295-304)
  createHostDiagnosticLog({ root, source, now }) [B tree-cli]   :335-339
  connectDaemon(root) [B tree-cli]   :341-343
  runRemoteHelper(url, dependencies) [H] remote-helper.ts:66   t: git-remote-helper.test.ts (fully faked deps)
    (every channel — repoPath, input, output, newOperationId, source, diagnostics, client — is in
     RemoteHelperDependencies :18-29; GIT_PROTOCOL :209,:216)
    projectFromRemote(url) [H] :228 ; parsePush(line) [H] :238 ; oneLine [H] :253
    targetName(...) [H] src/runtime/targets.ts:13
    diagnostic(deps, entry) [H] :256 → recordDiagnostic(log, entry) [H] src/cli/failure.ts:33 (never throws)
    deps.client.command(status/deploy/…) [B tree-daemon]

createProjectDocuments(root, run) [O] src/adapters/project-documents.ts:22   [B tree-daemon]   t: initialization-slug.test.ts:19 (fake run), effect-preparation.test.ts
  (boundary only; internals marked in tree-daemon.md. Git-side callees re-verified here:)
  createProjectDiscovery(run) [D] project.ts:32   (:26 — same defect, process.env :33)
  discover: discoverProject [O fs] config/documents.ts:177 ; read: readProjectConfig [O fs] :163 ; host: readHostConfig(root) [O fs] :201
  resolve: resolveTargetPlan [H] config/resolve.ts:70
  identifyInitialization/initializationInfo → inspectInitialization(path, command, discovery) [D] :86   [B tree-daemon: hidden readProjectConfig(repoPath) :101]
  initialize → ensureProjectGit(input, discovery) [H] project.ts:187   t: git-project.test.ts
      (rigRemoteUrl :191, GIT_REQUIRED :196, `git init` :201, GIT_INIT :203)
      inspectProjectLocation [H] :95 ; ensureRigRemote(input, discovery.run) [H] src/git/remotes.ts:58
        inspectRigRemote(input, run) [H] remotes.ts:18   (GIT_REMOTE :28,:51; conflict :44)
        rigRemoteUrl(project) [H] remotes.ts:8   (PROJECT_NAME)
    initializeProjectConfig(repoPath, input) [O fs] config/documents.ts:208   (:61-65)
  rename → readProjectConfig [O fs] ; renameRigRemote(input, run) [H] remotes.ts:79
      (GIT_REMOTE_MISSING :88, rollback :109-123, GIT_REMOTE_ROLLBACK :116, restore() :126-134)
      replaceUrl(repoPath, expected, next, push, run) [H] remotes.ts:137   (positional boolean `push` — style, not honesty)
    editProjectConfig(input) [O fs] documents.ts:286   (:74-78)

createDeploymentSources(store, run) [T] src/adapters/deployment-sources.ts:6   t: effect-preparation.test.ts (fake store), providers-git.test.ts (store)
  ↳ would be honest if: store.prepare — i.e. createGitSourceStore [D+T] as composed (composition.ts:96, no run)
    (the adapter itself declares both capabilities; with an honest store it is [H])
  git(repository, args) [H] :10   (GIT_SOURCE :13)
  preflight(input) → preflightDeployment(input, run) [H] src/git/preflight.ts:6   t: git-preflight.test.ts (fake run :7)
      (check-ref-format :11, show-ref :17 GIT_LOCAL_BRANCH :23, rev-parse :28 GIT_COMMIT :40, for-each-ref :45 GIT_UPSTREAM :50,:83,
       rev-list :64; warnings :57-63,:75-80,:91-98)
  prepare(request) → store.prepare [D] git-source-store.ts:37   (:22)
  resolve(repository, ref) [H] :23   (GIT_REF :25)
  currentBranch(repository) [H] :37   (GIT_DETACHED :43, GIT_SOURCE :49)
```

Propagation, subtree B:
- `createProjectDiscovery [D] :33` → `main [O]` (:327) — stops immediately; and → `createProjectDocuments [O]` (:26) — stops. No `[T]` nodes result because both callers are owners. (Daemon fragment's `inspectInitialization [D]` is independent of this.)
- `prepare [D]` (store) → `createDeploymentSources [T]` → composeDaemon [O].
- Everything else in B is `[H]`: `runRemoteHelper`, `createGitPushSource`, `inspectProjectGit`, `inspectProjectLocation`, `ensureProjectGit`, all of `remotes.ts`, `preflightDeployment`.

##### C. Config (as reached from readHostConfig / readProjectConfig / resolveTargetPlan / the config editor)

```
readHostConfig(stateRoot) [O fs] src/config/documents.ts:201   t: config.test.ts, config-control-plane.test.ts, config-profile-policy.test.ts
  (callers: composition.ts:35, project-documents.ts:31, cli/offline-doctor.ts:27, cli/host-inspection.ts:10, cli/host-log.ts:14)
  ↳ owner note: `resolve(stateRoot)` :202 — cwd-relative if stateRoot is relative (callers pass rigRoot(); benign)
  locateConfig(directory, stem) [O fs] :31   (access :43, read_failed :47, ambiguous_config :57)
  readDocument(path, parseHostConfig) → readDocumentSource(path, validate) [O fs] :142   (readFile :147; path hint :155)
    decodeDocument(raw, path, validate) [H] :112
      yamlDocument(raw, path) [H] :66   (YAML 1.2; anchors/tags/merge keys rejected)
      parseHostConfig(input) [H] src/config/schema.ts:389   → hostConfigSchema :282 ; validationError [H] ~:396
  parseHostConfig({}) [H] :205   (default when no file)

readProjectConfig(repoPath) [O fs] documents.ts:163   t: config.test.ts, initialization-slug.test.ts, migration.test.ts (via buildPreview)
  (callers: project-documents.ts:29,:68, adapters inspectInitialization :101, migration/files.ts:327)
  ↳ owner defect (no propagation): `resolve(repoPath)` :166 is cwd-dependent for relative input, and is
    inconsistent with initializeProjectConfig which passes raw `repoPath` to locateConfig :212 and joins :220 (see BUG-7)
  locateConfig [O fs] :31 → missing_config :168
  readDocumentSource(path, parseProjectConfig) [O fs] :142
    decodeDocument [H] :112 → yamlDocument [H] :66 ; parseProjectConfig(input) [H] schema.ts:277 → projectConfigSchema :185 (localhostCommand :17)

discoverProject(startPath) [O fs] documents.ts:177   [B tree-cli/tree-daemon]   t: config.test.ts
  (realpath :180, stat :181, upward walk :182-198) → locateConfig [O fs] ; readDocumentSource [O fs]

resolveTargetPlan(input) [H pure] src/config/resolve.ts:70   t: config.test.ts, config-profile-policy.test.ts, effect-preparation.test.ts
  (relative_root :71-78; `resolve(input.workspacePath, …)` :161 always has an absolute base once :71-78 has run → no cwd dependence)
  parseProjectConfig [H] schema.ts:277   (:79)
  resolveComponentProperties(...) [H] :171   (missing_port :194, port_collision :200)
    interpolate(value, properties) [H] :22   (unknown_interpolation :28)
  resolvePlanComponent({...}) [H] :264   (invalid_binding :338)
    resolveHooks [H] :36
  dependencyOrder(components) [H] :50

Config editor (daemon config-editor.ts:192,:224-225 → documents.read/preview/apply; composition.ts:118-122)
  readProjectConfigSource(repoPath) [O fs] documents.ts:237   t: config.test.ts
    locateConfig(resolve(repoPath)) :240 (same cwd note as :166) ; readDocumentSource [O fs]
  previewProjectConfig(input) [O fs] documents.ts:276
    readProjectConfigSource [O fs] :237
    prepareEdit(raw, path, input) [H] :247   (revision_conflict :253)
      validateEditPath(path) [H] src/config/editor.ts:8
      applyYamlEdits(document, edits) [H] editor.ts:19   (mutates the supplied Document — declared by parameter; lossy_edit :28,:56)
      applyJsonEdits(config, edits) [H] editor.ts:68
      parseProjectConfig [H] ; revisionOf [H] :26
  editProjectConfig(input) [O fs] documents.ts:286   t: config.test.ts
    (readProjectConfig :289, lock `open(lockPath,"wx")` :293 config_locked :295, readFile :304, backup wx :309 backup_conflict :316,
     temp write with preserved mode :322-326, second revision check :327-335, rename :336, finally unlink temp/lock :343-345)
    prepareEdit [H] :247

initializeProjectConfig(repoPath, input) [O fs] documents.ts:208   t: initialization-slug.test.ts, config.test.ts
  locateConfig(repoPath, "rig") :212 → already_initialized :213
  scaffoldProjectConfig(input) [H] :363   (duplicate_component :371,:381)
  writeFile(join(repoPath,"rig.yaml"), { flag: "wx" }) :221 ; readProjectConfig(repoPath) :222
```

Propagation, subtree C: none. Every non-pure node is an `[O fs]` owner (document readers/writers) and every pure node (`yamlDocument`, `decodeDocument`, `prepareEdit`, `scaffoldProjectConfig`, `applyYamlEdits`, `applyJsonEdits`, `parse*`, `resolveTargetPlan` and helpers, `validateEditPath`) is `[H]`. `schema.ts` has no ambient access (grep hits for `env` are schema field names). The only owner-level defect is the `resolve(repoPath)` cwd dependence at :166/:240 vs raw `repoPath` at :212/:220 (BUG-7).

##### D. Migration

```
createAdoptionGuard(root) [O] src/migration/adoption.ts:192   [B tree-daemon]   t: migration-adoption.test.ts   (only composed publication root: composition.ts:92)
  readLegacyAdoption(root) [O fs] adoption.ts:136   (LEGACY_ADOPTION_PENDING :196)
    pathFor(root) [H] :120 ; readFile :142 ; ENOENT probes runtime/rigd-state.json + registry.json :145-161 → invalid()
    parseManifest(raw) [H] :128   (LEGACY_ADOPTION_INVALID via invalid() :121)
    completed branch: readFile `.${pendingRevision}.bak` :170 ; digest :119 ; deep-equal / verifiedAt :180-186
    validateEvidence(manifest, evidence) [H] :203   (`Date.parse` on supplied values only :218,:225,:253 — not a clock read)

finalizeLegacyAdoption(root, input) [O fs] adoption.ts:262   t: migration-adoption.test.ts, migration-runtime-e2e.test.ts   (NO caller in src/)
  (lock wx :276 LEGACY_ADOPTION_LOCKED :278, readFile :286, LEGACY_ADOPTION_CHANGED :289,:332, LEGACY_ADOPTION_COMPLETED :295,
   backup wx/EEXIST :303-314, completedSchema :315, temp :323 open/write/sync :324-330, rename :337, finally :340-344)
  parseManifest [H] :128 ; validateEvidence [H] :203

readLegacyState(root, options = {}) [O fs] src/migration/files.ts:121   t: migration.test.ts   (NO caller in src/)
  loadSources(root) [O fs] :77   (`resolve(root)` :78 cwd-relative if relative; rigd-state.json required :79-83, registry.json :84,
      readdir runtime :94, per-dir deployments.json :98-106)
    readSource(root, path, required) [O fs] :40   (LEGACY_READ :50; hash :33; absent :35)
  buildPreview(loaded, options) [O fs] :288
    parseSource(source, schema) [H] :65   (LEGACY_CORRUPT :69)
    recoverSources(input, requested) [H pure] src/migration/source-evidence.ts:32   (structuredClone :41-42; unverified_recovered_source :50,:100)
    convertLegacyState({ legacy, registry, inventories }) [H pure] src/migration/convert.ts:26   t: migration.test.ts
        (duplicate_target :38, conflicting_target :50, missing_desired_state :58, missing_project :70, identity_conflict :83,
         missing_deployed_ref :95, runtimeStateSchema :120, invalid_converted_state :122)
      resolveProjects(legacy, registry, issues) [H] :154   (appends to caller-supplied `issues` — declared by parameter; registration_conflict :172, incomplete_registration :210)
      convertPlan(record, issues) [H] :221   (invalid_recorded_plan; targetPlanSchema :335)
        orderComponents [H] :341
      planAdoption(targets, projects) [H] :367   (legacyLabel :391-398, legacyMarker :416)
    realpath(project.repoPath) :308 ; stat :309 (missing_repository :312) ; shared_repository_identity :320
    readProjectConfig(repository) [O fs] config/documents.ts:163   (:327; current_identity_mismatch :329; ambiguous/invalid_current_config :346-353)
    sourceRevision(files) [H] :110

migrateLegacyState(root, options) [O fs] files.ts:145   t: migration.test.ts, migration-runtime-e2e.test.ts   (NO caller in src/)
  (MIGRATION_REVISION :155, resolve :160, mkdir :166, lock wx :169 MIGRATION_LOCKED :171, `mkdir(oldLock)` :183 LEGACY_BUSY :186,
   MIGRATION_CHANGED :196,:256, MIGRATION_BLOCKED :202, backups :208-239 MIGRATION_BACKUP :232, manifest :240-251,
   pending adoption wx :262-265, temp :267 open/write/sync :268-274, `link` :275, finally :278-284)
  assertAbsent(path) [O fs] :127   (MIGRATION_EXISTS; :165,:192)
  loadSources [O fs] :77 ; buildPreview [O fs] :288   (:193-194, :254)
```

Propagation, subtree D: none. All I/O sits in `[O fs]` publication roots (`readLegacyState`,
`migrateLegacyState`, `finalizeLegacyAdoption`, `createAdoptionGuard`/`readLegacyAdoption`,
`buildPreview`, `loadSources`, `readSource`, `assertAbsent`) and every calculation
(`convertLegacyState`, `resolveProjects`, `convertPlan`, `orderComponents`, `planAdoption`,
`recoverSources`, `parseSource`, `sourceRevision`, `parseManifest`, `validateEvidence`) is `[H]`
and pure. `schema.ts` :1-194 and `types.ts` :1-69 are zod/types only; `index.ts` re-exports.
Structural note: three of the four publication roots (`readLegacyState`, `migrateLegacyState`,
`finalizeLegacyAdoption`) have **no caller in `src/`** — only tests reach them — so the only
migration behaviour composed into the running system is the adoption guard.

---

#### 2. Propagation summary

| [D] node | file:line | cause | ancestors poisoned (→ owner) | would be honest otherwise? |
|---|---|---|---|---|
| child `observe` | child-supervisor.ts:149 | `process.kill(pid, 0)` bypasses `inspection` | `ensureRunning [T]` → `createChildSupervisor [D+T]` → composeDaemon [O]; also → `runCapturedProcess [O]` | yes, with `inspection.groupExists`/`exists` |
| child `stop` | child-supervisor.ts:212-220 | `Date.now()` ×4, `Bun.sleep(20)` ×2 despite received `now`; hidden 1500 ms kill deadline | `ensureRunning [T]`, `shutdown [T]` → `createChildSupervisor [D+T]` → composeDaemon / runCapturedProcess | yes, deadlines via `now()` + injected sleep |
| child `scheduleRestart` | child-supervisor.ts:250 | `setTimeout` timer channel undeclared | `captureOutput`→`ensureRunning [T]` → factory → owners | [T] until ensureRunning's other callees are fixed |
| `waitForCaptureStart` | capture-status.ts:39-57 | `Date.now`, `Bun.sleep(20)`, no clock/sleep params | child `ensureRunning [T]`, launchd `ensureRunning [T]` → both factories `[D+T]` → composeDaemon | yes |
| `createProcessInspection` | process-inspection.ts:32-35 | defaults `run`/`kill` | `createChildSupervisor [D+T]` (:67) → composeDaemon (no `processInspection`) | yes; members already honest |
| `createProcessIdentityReader` (no arg) | process-identity.ts:10 | default `run = runCommand` | `runCapturedProcess [O]` (:32) — stops | yes |
| `createChildSupervisor` | child-supervisor.ts:66-67 | defaults `now`, `inspection`; composition.ts:42 passes neither | composeDaemon [O] / runCapturedProcess [O] | no — still [T] via observe/stop/scheduleRestart/waitForCaptureStart |
| launchd `waitForApplication` | launchd-supervisor.ts:88-91 | 30 × `Bun.sleep(100)` uninjectable | `ensureRunning [T]` → `createLaunchdSupervisor [D+T]` → composeDaemon | yes |
| launchd `stop` | launchd-supervisor.ts:171-184 | 30 × `Bun.sleep(100)` uninjectable | `createLaunchdSupervisor [D+T]` → composeDaemon | yes |
| `createLaunchdSupervisor` | launchd-supervisor.ts:32-34 | defaults `run`, `inspect`, `now`; composition.ts:43-48 passes none | composeDaemon [O] | no — still [T] via waitForApplication/stop/waitForCaptureStart |
| installer `install` | artifact-installer.ts:66 | `Bun.which("bun")` PATH lookup when `bunExecutable` absent | `createArtifactInstaller [D+T]` → composeDaemon (no `bunExecutable`) | yes |
| `createArtifactInstaller` | artifact-installer.ts:35 | default `run`; composition.ts:64 passes nothing | composeDaemon [O] | no — still [T] via install |
| `createCaddyRouter` | caddy-router.ts:31 | default `run`; composition.ts:65-79 passes no run | composeDaemon [O] | yes — all methods honest given run |
| store `prepare` | git-source-store.ts:70,:85,:103 | `resolve()` against `process.cwd()` for relative repository/destination | `createGitSourceStore [D+T]` → `createDeploymentSources [T]` → composeDaemon | yes, with absolute-path validation or `cwd` |
| `createGitSourceStore` | git-source-store.ts:24 | default `run`; composition.ts:96 passes only root | `createDeploymentSources [T]` → composeDaemon | no — still [T] via prepare |
| `createProjectDiscovery` | git/project.ts:33 | `process.env` read in factory | `main [O]` (:327), `createProjectDocuments [O]` (:26) — stop at once | yes, with `env` parameter |

Subtrees C and D contribute no rows: every dishonest-looking behaviour there is inside an `[O fs]` owner.

---

#### 3. Ledgers for every [D] / [D+T] node

**createChildSupervisor(options) [D+T]** — child-supervisor.ts:56
- inputs: `stateRoot`, `captureCommand?`, `now?`, `processInspection?`, `stopTimeoutMs?`, `restartLimit?/WindowMs?/BackoffMs?` (:45-54)
- outputs: `Supervisor` (contracts.ts:18-25)
- ambient: `new Date()` :66 and `createProcessInspection()` :67 (→ `runCommand`, `process.kill`) when defaulted — **as composed, both defaulted**
- prerequisites: writable `stateRoot`
- failure: none at construction
- callees+trust: createProcessInspection [D as defaulted]; methods below

**child.observe(key, signal?) [D]** — :118
- inputs: key, signal?; lease/capture files under stateRoot via `recover`
- outputs: `ProcessObservation`
- ambient: `process.kill(owned.pid, 0)` :149
- prerequisites: recovered lease or in-memory owned process
- failure: never throws; EPERM/any error → `{ state: "unknown" }`
- callees+trust: recover [H], inspect [H given run]

**child.stop(key) [D]** — :177
- inputs: key; `options.stopTimeoutMs`, `options.captureCommand`
- outputs: `{ outcome }`; removes lease :231 and capture files :232
- ambient: `Date.now()` :212,:214,:218,:219; `Bun.sleep(20)` :215,:220; constants 4000/1500 :213, 1500 :218
- prerequisites: owned pid with matching identity :203
- failure: STOP_TIMEOUT :222; PROCESS_SIGNAL/PROCESS_INSPECT from inspection
- callees+trust: inspection.signalGroup/groupExists [H given kill/run], inspect [H given run]

**child.scheduleRestart(request, exitCode) [D]** — :235
- inputs: request, exitCode; `options.restart*`; received `now()` :244
- outputs: mutates `restarts` map; sets `restartPending`
- ambient: `setTimeout` :250
- prerequisites: not shutting down
- failure: swallowed (restart limit → return :248)
- callees+trust: ensureRunning [T]

**waitForCaptureStart(requestPath, timeoutMs = 5000) [D]** — capture-status.ts:35
- inputs: requestPath, timeoutMs
- outputs: `{ state: "running", pid }`
- ambient: `Date.now()` :39,:40; `Bun.sleep(20)` :57
- prerequisites: wrapper writes `*.status.json`
- failure: PROCESS_START :50 (failed status), PROCESS_START_TIMEOUT :59
- callees+trust: readFile on declared path

**createProcessInspection(options = {}) [D]** — process-inspection.ts:29
- inputs: `run?`, `kill?`
- outputs: `ProcessInspection { identity, groupExists, signalGroup }`
- ambient: `runCommand` :32, `process.kill` :33-35 when defaulted — **defaulted as composed (child :67)**
- prerequisites: none
- failure: PROCESS_INSPECT :53, PROCESS_SIGNAL :71 (from members)
- callees+trust: createProcessIdentityReader(run) [H given run]

**createProcessIdentityReader(run = runCommand) [D when called bare]** — process-identity.ts:9
- inputs: run (defaulted at captured-process.ts:32)
- outputs: `(pid) => Promise<string | undefined>`
- ambient: `runCommand` when defaulted
- prerequisites: `/bin/ps` available
- failure: PROCESS_INSPECT :21
- callees+trust: run

**createLaunchdSupervisor(options) [D+T]** — launchd-supervisor.ts:31
- inputs: root, domain, labelPrefix, run?, inspect?, now?, captureCommand? (:18-29)
- outputs: `Supervisor`
- ambient: `runCommand` :32, `createProcessIdentityReader(run)` :33, `Date.now` :34 — **all defaulted as composed (composition.ts:43-48)**
- prerequisites: launchctl in PATH of `run`
- failure: none at construction
- callees+trust: observe [H given run/inspect/now], waitForApplication [D], stop [D], ensureRunning [T]

**launchd.waitForApplication(key) [D]** — :87
- inputs: key
- outputs: application pid
- ambient: `Bun.sleep(100)` × 30 :91 (3 s wall clock)
- prerequisites: job bootstrapped
- failure: LAUNCHD_START :93
- callees+trust: observe [H given …]

**launchd.stop(key) [D]** — :155
- inputs: key
- outputs: `{ outcome }`; removes plist/json under options.root :180-181
- ambient: `Bun.sleep(100)` × 30 :184
- prerequisites: `launchctl print` reachable
- failure: LAUNCHD_UNKNOWN :163, LAUNCHD_FAILED (checked :170), LAUNCHD_STOP :186
- callees+trust: run, checked [H given run]

**createArtifactInstaller(options = {}) [D+T]** — artifact-installer.ts:29
- inputs: `run?`, `bunExecutable?` (:30-33)
- outputs: `ArtifactInstaller { install, observe }`
- ambient: `runCommand` :35 when defaulted — **defaulted as composed (composition.ts:64)**
- prerequisites: none at construction
- callees+trust: install [D], observe [H]

**installer.install(request) [D]** — :37
- inputs: request (build command, cwd, env, entrypoint, destination)
- outputs: shim/binary at `request.destination`; returns artifact descriptor
- ambient: none (FIXED #229; `bunExecutable` is a required option)
- prerequisites: build succeeds; entrypoint exists
- failure: BUILD_FAILED, ARTIFACT_MISSING (BUN_MISSING removed by #229)
- callees+trust: run [caller-supplied], fs under destination

**createCaddyRouter(options) [D]** — caddy-router.ts:23
- inputs: caddyfile, reload, extraConfig, reloadCommand?, run?, executable? (:23-30)
- outputs: `Router { change, checkpoint, restore }`
- ambient: `runCommand` :31 when defaulted — **defaulted as composed (composition.ts:65-79)**; `executable ?? "caddy"` :91 is resolved by `run`
- prerequisites: writable caddyfile dir
- failure: ROUTE_* codes (:47,:63,:73,:113,:135, :203)
- callees+trust: change/checkpoint/restore/helpers [H given run]

**createGitSourceStore({ root, run? }) [D+T]** — git-source-store.ts:20
- inputs: root, run?
- outputs: `SourceStore { prepare }`
- ambient: `runCommand` :24 when defaulted — **defaulted as composed (composition.ts:96)**
- prerequisites: writable root
- callees+trust: prepare [D]

**store.prepare(request) [D]** — :37
- inputs: `{ project, repository, ref, destination }`; serialised per project :108-120
- outputs: worktree at destination; mirror under root; returns commit
- ambient: `process.cwd()` through `resolve(request.repository)` :70,:85 and `resolve(request.destination)` :103 when inputs are relative
- prerequisites: repository readable by git; destination absent
- failure: GIT_REF :41, GIT_COMMIT :51, WORKSPACE_EXISTS :90, GIT_FAILED :29-34 (raw stderr in details :33)
- callees+trust: git [H given run], exists [H], fs under root

**createProjectDiscovery(run) [D]** — git/project.ts:32
- inputs: run
- outputs: `ProjectDiscovery { canonicalize, run }` (:26-29)
- ambient: `process.env` :33 captured at construction and merged into every git invocation :36-37
- prerequisites: none
- failure: none at construction
- callees+trust: realpath (declared canonicalize), run

---

#### 4. Concrete BUGs / hazards noticed (separate from honesty marks)

1. **BUG-1 child-supervisor.ts:149 — `process.kill(owned.pid, 0)` bypasses `ProcessInspection`.**
   Scenario: rigd runs as a different uid from a recovered lease's process (or under a sandbox that denies signal 0). `process.kill` throws EPERM, the catch path reports `{ state: "unknown" }`, and the daemon can neither confirm nor restart the component, whereas `inspection.groupExists` :36-60 has the `ps -g` EPERM fallback for exactly this. Also means providers-process-stop.test.ts's fake `kill` does not control this probe.
2. **BUG-2 child-supervisor.ts:212-220 — stop deadlines ignore the `now` option.**
   Scenario: tests or a replayed clock inject `now`; stop still spins on real `Date.now()`/`Bun.sleep(20)` for up to 4000+1500 ms. The SIGKILL grace (1500 ms :218) cannot be configured even though `stopTimeoutMs` exists (:47), so a slow-to-die group always costs 1.5 s more than the caller asked for before STOP_TIMEOUT :222.
3. **BUG-3 launchd-supervisor.ts:106-107 — `restartPending` path can block 3 s per call.**
   Scenario: a captured application is in restart backoff (child-supervisor.ts:264, `100 · 2^(n-1)` ms, up to 1600 ms at the default limit of 5); `ensureRunning` sees `restartPending` and enters `waitForApplication`, which polls 30 × 100 ms of real time and throws LAUNCHD_START :93 if backoff plus application start-up plus a fresh observation (≤ 1000 ms old, capture-observation.ts:74) does not land inside 3 s — even though the job is healthy and merely waiting. An `up` on such a target then fails spuriously with "The managed job did not start."
4. **BUG-4 launchd-supervisor.ts:122 — request JSON written non-atomically.**
   `writeFile(requestPath, …)` overwrites in place while the child supervisor uses tmp+rename (:299-309) and the wrapper reads `requestPath` on start (captured-process.ts:21). Scenario: a `bootout`→`bootstrap` race or a crash mid-write leaves a truncated request; the new wrapper fails `requestSchema.parse` and reports `failed` (BUG-5 path), and `waitForCaptureStart` surfaces PROCESS_START with the generic message.
5. **BUG-5 captured-process.ts:68-73 — catch-all rewrites a `running` status as `failed`.**
   Scenario: the application started (`writeCaptureStatus({ state: "running" })` :43-46), then any later exception in the observation loop (e.g. `inspect(state.pid)` throwing PROCESS_INSPECT :51, or a transient EIO in `writeCaptureObservation`) drops to the catch, which overwrites the status file with `{ state: "failed", message: "The managed component could not start." }` and exits 1 — while the child may still be running detached under the wrapper's group. launchd then shows a failed job whose application keeps running with nobody supervising it.
6. **BUG-6 git-source-store.ts:70,:85,:103 — relative `repository`/`destination` resolve against rigd's cwd.**
   Scenario: a deploy request whose project `repoPath` is relative (nothing in `SourceStore`'s contract forbids it) is cloned from `<rigd cwd>/<path>`; under launchd the daemon cwd is `/`. The error would be GIT_FAILED with git's stderr, not a validation message.
7. **BUG-7 config/documents.ts:166,:240 vs :212,:220-222 — inconsistent path normalisation.**
   `readProjectConfig`/`readProjectConfigSource` call `locateConfig(resolve(repoPath))` but `initializeProjectConfig` calls `locateConfig(repoPath)` and `join(repoPath, "rig.yaml")`. Scenario: relative `repoPath` from a caller whose cwd differs from rigd's — initialisation checks/writes one directory and the immediate re-read at :222 resolves another; the write succeeds (`wx`) and the re-read throws `missing_config`, leaving a stray `rig.yaml`.
8. **HAZARD-8 error details carry raw subprocess stderr** — git-source-store.ts:33, caddy-router.ts:117,:143 (validate/reload output), launchd-supervisor.ts:45. `RigError.details` is "bounded context" per domain/errors.ts:3; stderr from `git clone` of a remote can include the repository URL with embedded credentials, and Caddy validation echoes config lines. Not a crash, but a leak channel into diagnostics and CLI output.
9. **HAZARD-9 composition.ts:45 — `process.getuid?.() ?? 501`.** On any platform where `getuid` is undefined the launchd domain silently becomes `gui/501`; there is no error path. Owner-level, but the fallback constant is a guess about the user, not evidence.
10. **HAZARD-10 migration/files.ts:121,:145 and adoption.ts:262 have no callers in `src/`.** `readLegacyState`, `migrateLegacyState`, `finalizeLegacyAdoption` are test-only; the only migration behaviour a user can reach is `createAdoptionGuard` (composition.ts:92), which blocks `up`/`deploy` with LEGACY_ADOPTION_PENDING :196 when `runtime/legacy-adoption.json` is pending — with no command able to move it to `completed`. If a pending manifest ever exists on disk the daemon is wedged until the file is edited by hand.
11. **FIXED (#229).** **NOTE-11 artifact-installer.ts:66 — `Bun.which("bun")` in the daemon's PATH.** Under launchd the daemon PATH is the launchd default (`/usr/bin:/bin:/usr/sbin:/sbin`), so a user-local `~/.bun/bin/bun` is not found and every source-entrypoint install fails BUN_MISSING :68 unless PATH was captured elsewhere. composeDaemon could pass `bunExecutable: process.execPath` (it is already bun).
