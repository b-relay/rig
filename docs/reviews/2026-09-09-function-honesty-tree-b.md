# Function honesty call tree (reviewer B)

- Repository: `b-relay/rig`, commit `f6d48fe3fc7b0d3b4473bebcb8fae4e577cf4b9f` on `chore/repository-cleanup`
- Date: 2026-09-09
- Method: `function-design` skill applied by reading source only. No code, config, Git state, or runtime state was modified. No tests were run. Reviewer A's report was not read.
- Deliverable: call trees rooted at the three compiled entrypoints, a coverage index, ledgers for the consequential boundaries, and classified findings with the tests that would govern them.
- Parent verification corrections: this review was drafted independently, then the parent orchestrator checked specific claims against source and asked for corrections. This revision patches those items in place: resolver purity versus `cwd` (sections 6, 8, 10, 13), timers inside `src/runtime/` (sections 6, 8, 9.5), coverage of production wiring by end-to-end suites (sections 6, 8, 9.3, 10, 12), the `FileStateStore` ledger and its conflation with the config editor (sections 9.9, 13), the diagnostic-log and provider-default classifications (sections 3, 6, 10), the `realpath` channel in `inspectProjectGit` (sections 5, 8, 13), and the status deadline reason (section 10). No cross-review text was shared and reviewer A's report was still not read.
- Final parent edit: narrowed remaining blanket claims about runtime effects and coverage, propagated tree qualifications, and separated client duplication from hidden dependencies. Test references establish inspected coverage, not passing results from this review.

## 1. Legend

| Mark | Meaning |
| --- | --- |
| `[O]` | Intentional effect owner. Declares itself as the place where ambient state is acquired or the outside world is touched (main, host, adapters, providers, file readers). Dishonest by design and acceptable when the job says so. |
| `[H]` | Honest. Every capability arrives through parameters or an injected dependency object. Effects are visible in the signature and can be substituted in tests. |
| `[P]` | Pure. Deterministic over inputs, no reads or writes outside its arguments. |
| `[D]` | Dishonest hidden dependency. The signature does not reveal a read or write the body performs, or the body reaches a default ambient implementation when the caller omits an argument. |
| `[H~]` | Honest with a qualification. Capabilities are explicit, but the body owns a documented timer or deadline, or a callee reaches an ambient default the caller did not choose. Callers inherit the qualification. |
| `[P~]` | Pure over the input domain that production callers use, but the signature admits inputs for which the body reads ambient state. |
| `[?]` | Unresolved or unverified. Path not traced to the leaf, or trust claim not confirmed against a test. |
| `<-D` | Transition point: an honest or pure caller reaches a dishonest callee here, so the caller inherits the hidden dependency. |

Reading rule from the skill: a callee's ambient access is the caller's ambient access. A wrapper that looks pure but calls `process.env`, `Date.now()`, a global `fetch`, or a module-level `runCommand` two frames down is not pure at its own boundary.

## 2. Explicit effects are not dishonesty

Rig is a process manager and its whole purpose is side effects: spawning children, writing state files, rewriting a Caddyfile, and talking to launchd. Those effects are not findings. A function is honest when the effect is part of its declared job and reaches it through a visible capability. `FileStateStore.update` writes to disk and says so in its type. `createCaddyRouter(...).apply` rewrites the Caddyfile and that is its name. The dishonesty this review looks for is narrower: reads or writes that a caller cannot see from the signature, or defaults that quietly substitute an ambient implementation when a dependency is omitted. Where the effect owner is clearly labelled and sits at the edge, it is listed as `[O]` and is a good boundary.

## 3. Call tree: `rig` (src/index.ts)

```
main(args)                                                   [O] src/index.ts:10-75
├─ rigRoot()                                                 [O] src/cli/entry-environment.ts:5-7   process.env.RIG_ROOT, homedir()
├─ process.once("SIGINT"/"SIGTERM")                          [O] src/index.ts:14-15
├─ process.cwd()                                             [O] src/index.ts:19            captured once as cwd
├─ userOutput()                                              [O] src/cli/entry-environment.ts:8-17   process.stdout/stderr
├─ createHostDiagnosticLog({root, source, now})              [O] src/diagnostics/host-log.ts:8-21   documented lazy adapter (doc at :7): Host policy is read on first record so help never needs valid config
│   └─ record(entry)
│       ├─ readHostConfig(root)                              [O] src/config/documents.ts:201-206     deferred by design; a parse failure falls back to defaults silently at host-log.ts:16
│       │   └─ parseHostConfig                               [P] src/config/schema.ts:386-390
│       └─ createFileDiagnosticLog(options)                  [O] src/diagnostics/file-log.ts:71-120  sqlite lock 123-149, rotation 150-179, prune 210-229
├─ createTerminalInteraction(stdin, stderr, signal)          [O] src/adapters/terminal-interaction.ts:14-81   only when both are TTYs (index.ts:28)
├─ client.command(request)   inline closure                  [O] src/index.ts:37-69
│   ├─ readDaemonAddress(root)                               [O] src/daemon/files.ts:50 -> readRecord 17-48
│   ├─ inspectOfflineHost(root, request.repoPath ?? process.cwd())
│   │                                                        [O] src/daemon/offline-doctor.ts:12-50   <-D process.cwd() re-read at index.ts:43 and :64 although cwd was captured at :19
│   ├─ readDaemonToken(root)                                 [O] src/daemon/files.ts:57-71
│   └─ new DaemonClient({port, token}).command(request)      [O] src/daemon/client.ts:37-47
│       └─ request(path, body, timeoutMs)                    [O] src/daemon/client.ts:48-88   global fetch :55; timeouts 5000/300000 fixed at :42
└─ runRigCli(args, dependencies)                             [H] src/cli/rig.ts:10-75
    ├─ requestsStructuredOutput(args)                        [P] src/cli/rig.ts:109-117
    ├─ createRigCommand(cwd, output, execute)                [H] src/cli/commands.ts:19-87
    │   ├─ initRequest / targetRequest / positiveInteger     [P] src/cli/commands.ts:296-377, 378-412, 413-421
    │   └─ execute(request)                                  [H] src/cli/rig.ts:17-52
    │       ├─ prepareInteractiveRequest(request, deps)      [H] src/cli/interaction.ts:34-160
    │       │   ├─ deps.client.command({action:"deployment-context"...})   -> closure above
    │       │   ├─ deps.interaction.*                        -> createTerminalInteraction
    │       │   ├─ deps.output.error("Detached HEAD ...")    side channel, src/cli/interaction.ts:152-155
    │       │   └─ readReply                                 [H] src/cli/interaction.ts:169-178
    │       ├─ deps.client.command(request)                  -> closure above
    │       ├─ render*                                       [P] src/cli/output.ts:2-140; terminalText [P] src/cli/terminal-text.ts
    │       ├─ followLogs(request, initial, deps)            [H~] src/cli/rig.ts:78-94   inherits the default timer below
    │       │   └─ (deps.wait ?? wait)(250, signal)          [D] src/cli/rig.ts:85 -> module wait :95-106 setTimeout   <-D main never injects wait; cli.test.ts:371-415 injects one, so the default timer path has no test
    │       └─ reportFailure(...)                            [H] src/cli/failure.ts:51-88
    │           └─ recordDiagnostic                          [H] src/cli/failure.ts:33-42   swallows diagnostic write failure by design
    └─ diagnostics.record(...)                               -> createHostDiagnosticLog above
```

Where honesty hits dishonesty in this tree:

1. `runRigCli` is honest, but the `client` it receives is the inline closure at `src/index.ts:37-69`. That closure is the real effect owner for the CLI. It is unnamed, untested in isolation, and re-reads `process.cwd()` at `:43` and `:64` even though `cwd` was already captured at `:19`.
2. `followLogs` at `src/cli/rig.ts:85` reaches the module timer whenever `wait` is not injected, and `main` never injects it. The optional `wait` field on `CliDependencies` makes the timer a hidden default rather than a declared capability. The follow test at `src/cli/cli.test.ts:371-415` injects `wait`, and no end-to-end suite passes `--follow`, so the default timer path is untested rather than proven different.
3. `createHostDiagnosticLog` is a documented lazy adapter: its doc comment at `src/diagnostics/host-log.ts:7` states that Host policy is acquired on first record so help and parser-only requests never depend on valid config. The config read is therefore its declared job, not a hidden contract. The one undeclared channel is the fallback at `:16`, which drops the parse failure without recording it, so an operator with a broken host config gets default diagnostics and no evidence why.

## 4. Call tree: `rigd` (src/rigd.ts)

```
main(args)                                                   [O] src/rigd.ts:10-37
├─ rigRoot()                                                 [O] src/cli/entry-environment.ts:5-7
├─ branch "capture"   args[0] === "capture"
│   └─ runCapturedProcess(args[1])                           [O] src/providers/captured-process.ts:16-54
│       ├─ process.on SIGTERM/SIGINT/SIGHUP                  src/providers/captured-process.ts:25-27
│       ├─ Bun.sleep(50)                                     :38
│       └─ writeCaptureStatus / clearCaptureStatus           [O] src/providers/capture-status.ts:21-33, 18-20
├─ branch daemon child   process.env.RIG_DAEMON_CHILD === "1"   src/rigd.ts:16
│   ├─ daemonCommand()                                       [O] src/cli/entry-environment.ts:18-22   process.argv[1], process.execPath, import.meta.dir
│   ├─ composeDaemon(root, [...daemonCommand(), "capture"])   [O] src/daemon/composition.ts:31-158   composition root; expanded in section 6
│   └─ runDaemonHost({root, port: 0, ...runtime})            [O] src/daemon/host.ts:17-124
│       ├─ owner = {pid: process.pid, instanceId}            src/daemon/host.ts:31
│       ├─ processExists(pid) -> process.kill(pid, 0)        src/daemon/host.ts:53, 125-132
│       ├─ startControlPlane(...)                            [O] src/daemon/server.ts:20-136   Bun.serve on 127.0.0.1
│       │   ├─ authenticated(request)                        [P] src/daemon/server.ts:13-17   timingSafeEqual on bearer token
│       │   ├─ GET /health -> {pid: process.pid}             src/daemon/server.ts:53
│       │   ├─ /v1/config -> options.editor                  src/daemon/server.ts:56-90 -> createConfigEditor (section 6)
│       │   └─ POST /v1/command -> commandSchema.parse       [P] src/daemon/protocol.ts:4-67 -> options.handle = runtime.command   src/daemon/server.ts:95-109
│       ├─ address file rename                               src/daemon/host.ts:85-91
│       ├─ stop(exitCode) -> process.exitCode                src/daemon/host.ts:98-114
│       ├─ process.once SIGTERM/SIGINT                       src/daemon/host.ts:115-116
│       └─ void options.start?.().catch(() => stop(1))      src/daemon/host.ts:120
└─ branch admin CLI
    └─ runRigdCli(args, {admin, output, newOperationId, diagnostics})   [H] src/cli/rigd.ts:14-67
        └─ admin = new DaemonAdmin({root, command: daemonCommand(), mode, userHome: homedir()})   [O] src/daemon/admin.ts
            │   mode from process.env.RIG_ROOT at src/rigd.ts:26; homedir() at :27
            ├─ constructor: activity ?? createAdminActivityJournal({now: () => new Date()...})   [O] src/daemon/admin.ts:55-59   real clock when no journal is injected; a convenience default in an OS adapter
            ├─ status()                                      [O] src/daemon/admin.ts:61-95 -> readDaemonAddress/readDaemonOwner, DaemonClient.health (1500 ms, client.ts:30-36)
            ├─ performInstall()                              [O] src/daemon/admin.ts:136-178   token via randomBytes, "wx" create
            │   ├─ spawnDetached()                           [O] src/daemon/admin.ts:252-284   env: {...process.env, RIG_ROOT, RIG_DAEMON_CHILD}   :269
            │   └─ installLaunchd()                          [O] src/daemon/admin.ts:321   plist embeds process.env.PATH
            ├─ performUninstall()                            [O] src/daemon/admin.ts:179-251
            │   ├─ launchctl(["bootout", labelDomain()])     :226   or process.kill(pid, "SIGTERM")   :227
            │   ├─ Date.now() deadline loop                  :228-229
            │   └─ client.command({action:"cancel-uninstall"}).catch(() => {})   :238
            ├─ launchctl(args) -> Bun.spawn(["/bin/launchctl", ...])   [D] src/daemon/admin.ts:299-316   <-D bypasses the CommandRunner interface every other provider uses
            ├─ label() -> Bun.hash(root)                     src/daemon/admin.ts:286
            └─ labelDomain() -> process.getuid?.() ?? 501    src/daemon/admin.ts:289, 326
```

Where honesty hits dishonesty in this tree:

1. `runRigdCli` is honest and tested with a fake admin (`src/cli/rigd.test.ts`). `DaemonAdmin` itself is exercised for real in process mode by `tests/daemon-admin.test.ts` (install starts a real service; failed stop cancels uninstall quiescence). It reaches `process.env`, `process.getuid`, `Date.now`, `process.kill`, and a raw `Bun.spawn` for launchctl. Most of that is legitimate for an installer. The raw `Bun.spawn` at `src/daemon/admin.ts:300` is the one that breaks the project rule that concrete process APIs sit behind provider interfaces, and the launchd-mode branch it serves has no test.
2. `runDaemonHost` owns process identity and signals, and declares it. The hidden part is `process.pid` leaking into the `/health` payload at `src/daemon/server.ts:53`, which couples the wire format to the host process.

## 5. Call tree: `git-remote-rig` (src/git/remote-helper.ts)

```
main(args)                                                   [O] src/git/remote-helper.ts:312-360
├─ userOutput()                                              [O] src/cli/entry-environment.ts:8-17
├─ inspectProjectGit(process.cwd(), runCommand)              [O] src/git/project.ts:22-58   realpath at :26 and :37 beside the runner; process.cwd() at remote-helper.ts:326
├─ rigRoot()                                                 [O] src/cli/entry-environment.ts:5-7
├─ createInterface({input: process.stdin})                   [O] src/git/remote-helper.ts:330
├─ createGitPushSource(repoPath, runCommand)                 [H] src/git/remote-helper.ts:266-309
├─ createHostDiagnosticLog({root, source:"rig", now})        [O] src/diagnostics/host-log.ts:8-21   same documented lazy read as tree 1; fallback at :16 is silent
├─ client.command(command)   inline closure                  [O] src/git/remote-helper.ts:339-353
│   ├─ readDaemonAddress(root)                               [O] src/daemon/files.ts:50
│   ├─ readDaemonToken(root)                                 [O] src/daemon/files.ts:57-71
│   └─ new DaemonClient({port, token}).command(command)      [O] src/daemon/client.ts:37-47   global fetch
└─ runRemoteHelper(url, dependencies)                        [H] src/git/remote-helper.ts:67-229
    ├─ projectFromRemote(url)                                [P] src/git/remote-helper.ts:230-239
    ├─ parsePush(line)                                       [P] src/git/remote-helper.ts:240-254
    ├─ dependencies.source.*                                 -> createGitPushSource (CommandRunner-based)
    ├─ dependencies.client.command(...)                      -> closure above
    └─ dependencies.diagnostics.record(...)                  -> createHostDiagnosticLog
```

This tree is the cleanest of the three. `runRemoteHelper` takes every capability explicitly and `tests/git-remote-helper.test.ts` drives it with fakes. The transitions are the inline client closure shared with `rig`, and `inspectProjectGit`, which exposes only a `CommandRunner` yet also calls `realpath` at `src/git/project.ts:26` and `:37`. It is a deliberate filesystem-plus-git discovery adapter with an incompletely stated seam: a fake runner does not make it hermetic, because the path it returns still depends on the real filesystem. `createGitPushSource` has no direct unit test; it is exercised through `tests/git-push.test.ts` end to end.

## 6. Shared subtree: daemon composition to providers

This subtree is reached only from the daemon-child branch of `rigd`. It is where the honest runtime core meets the effect-owning adapters and providers.

```
composeDaemon(root, captureCommand)                          [O] src/daemon/composition.ts:31-158
├─ readHostConfig(root)                                      [O] src/config/documents.ts:201-206
├─ createFileDiagnosticLog({root, source:"rigd", now, ...host.diagnostics})   [O] src/diagnostics/file-log.ts:71-120
├─ createChildSupervisor({stateRoot: root, captureCommand})  [O] src/providers/child-supervisor.ts:57-396
│   ├─ now = options.now ?? (() => new Date())               [O] src/providers/child-supervisor.ts:67   real clock by default; tests/providers-process.test.ts builds the supervisor with defaults, so this path is tested
│   ├─ inspect = options.inspect ?? createProcessIdentityReader()   [O] :68   default identity reader; same tests exercise it against real /bin/ps
│   │   └─ createProcessIdentityReader(run = runCommand)     [O] src/providers/process-identity.ts:9-32   ambient runner by default; no direct unit test
│   ├─ recover()                                             [O] :88-117   lease files
│   ├─ observe()                                             [O] :118-177   process.kill(pid, 0) at :150
│   ├─ stop()                                                [O] :178-234   Date.now at :213 and :218; signalGroup :471-488
│   │   └─ groupExists(pid)                                  [D] :449-470   EPERM fallback calls module-level runCommand at :456-459; no injection point, branch unverified [?]
│   ├─ scheduleRestart()                                     [O] :235-268   setTimeout backoff, limit 5 per 60 s
│   ├─ ensureRunning(request)                                [O] :269-380   spawn detached :310-315; lease :357-371
│   │   └─ waitForCaptureStart(requestPath, timeoutMs = 5000)   [O] src/providers/capture-status.ts:35-64   Date.now :39-40, Bun.sleep :57
│   └─ captureOutput()                                       [O] :397-448
├─ createLaunchdSupervisor({root, domain: gui/<getuid>, labelPrefix: com.b-relay.rig.<sha256 12>, captureCommand})
│                                                            [O] src/providers/launchd-supervisor.ts:22-176
│   ├─ run = options.run ?? runCommand                       [O] :23   convenience default; providers-launchd injects a fake runner, so the real launchctl path is unverified [?]
│   ├─ observe() via launchctl print                         :38-69
│   ├─ ensureRunning()                                       :72-133   plist write, bootout/bootstrap, 30 x 100 ms poll
│   └─ xml / launchdPlist                                    [P] :177-184, 185-195
├─ environment <- process.env                                [O] src/daemon/composition.ts:54-58   acquired once, passed down
├─ createTargetEffects({root, supervisors, run: runCommand, installer, router, environment})
│                                                            [O] src/adapters/target-effects.ts:55-482
│   ├─ createArtifactOwnership(root)                         [O] src/adapters/artifact-ownership.ts:30-107   built at target-effects.ts:58
│   ├─ createEffectTransactions({root, ownership, router})   [O] src/adapters/effect-transactions.ts:68-325   built at target-effects.ts:59-63
│   ├─ installer = createArtifactInstaller()                 [O] src/providers/artifact-installer.ts:29-103
│   │   ├─ run = options.run ?? runCommand                   [O] :35   default; tests/target-effects.test.ts:43-44 builds createArtifactInstaller() with the real runner
│   │   └─ Bun.which("bun") when bunExecutable omitted       [O] :66   ambient PATH lookup, offered as an override; declared by the option
│   ├─ router = createCaddyRouter({caddyfile, reload, extraConfig, reloadCommand?})   [O] src/providers/caddy-router.ts:23-176
│   │   ├─ run = options.run ?? runCommand                   [O] :31   default; every providers-caddy test injects run or wraps runCommand
│   │   ├─ change()                                          :33-151   validate, backup, rename, reload, rollback
│   │   └─ hostnamePresent / routeMarkers / ownedBlock       [P] :177-190, 192-195, 198-218
│   ├─ supervisor(target)                                    [H] :72-83   PROVIDER_MISSING
│   ├─ environment(target, component)                        [O] :84-95 -> readEnvironment :493-528
│   ├─ runTarget(...)                                        [H] :96-113
│   ├─ recordOutput(...)                                     [D] :114-139   new Date().toISOString() at :126; the effects object receives no clock, so log timestamps are an undeclared channel (low impact)
│   ├─ health(component, target, signal)                     [O] :140-167   concrete http probe via global fetch at :148; the capability is declared by the health signature; proven end to end by rig-e2e (health: http://127.0.0.1:${web.port}) and full-project-e2e (/health)
│   ├─ checkpoint(target)                                    [H] :214-234 -> transactions.checkpoint :165-250
│   ├─ prepare(target)                                       [O] :241-320   mkdir, sqlite touch :252, initdb :259-269, dependency install :288-302
│   ├─ hook(...)                                             [O] :321-337
│   ├─ install(...)                                          [O] :338-402   ownership.inspect, installer.build, ownership.publish, writeInstallReceipt :555-560
│   ├─ route(target) / removeRoute(target)                   [O] :403-426, 427-433
│   └─ observations                                          [O] :434-480   artifact "unknown" on any error :475
├─ store = new FileStateStore(root)                          [O] src/runtime/state-store.ts:22-62 read, 64-82 update
│   └─ state-schema invariants                               [P] src/runtime/state-schema.ts:123-176
├─ createAdminActivityJournal({root, now, id})               [O] src/adapters/admin-activity.ts:52-121
├─ createRuntime({...})                                      [H~] src/runtime/application.ts:35-510
│   deps wired at composition.ts:87-110:
│   │  inspectHost: () => inspectHost(root)                  [O] src/adapters/host-inspection.ts:7-86   Bun.which at :43
│   │  assertOwnershipReady: createAdoptionGuard(root)       [O] src/migration/adoption.ts:192-202   the only migration entry wired into the daemon
│   │  documents: createProjectDocuments(root, runCommand)   [O] src/adapters/project-documents.ts:18-80
│   │  sources: createDeploymentSources(createGitSourceStore({root}), runCommand)   [O] src/adapters/deployment-sources.ts:6-57
│   │     └─ createGitSourceStore run = options.run ?? runCommand   [O] src/providers/git-source-store.ts:24   default; providers-git tests inject run; the default is reached only through the e2e suites
│   │  lifecycle: createTargetLifecycle(effects)             [H] src/runtime/lifecycle.ts:68-261
│   │  files: createRuntimeFiles()                           [O] src/adapters/runtime-files.ts:6-27   reservePorts -> availablePort :28-46; logs -> readTargetLogs
│   │  now / id / diagnostic                                 explicit
│   └─ command(command)                                      [H~] src/runtime/application.ts:461-467   reads bypass the mutation queue
│       └─ execute(command)                                  [H~] :38-438
│           ├─ selectProject / registerProject               [H] src/runtime/projects.ts:8-55, 56-112   catch at :103-110 drops the original cause
│           ├─ updateRegistration                            [H~] src/runtime/registration.ts:7-125   mutates caller-owned project.name at :73
│           ├─ planTarget(input, deps)                       [H~] src/runtime/targets.ts:34-174
│           │   ├─ targetName                                [P] :9-33
│           │   ├─ deps.documents.resolve -> resolveTargetPlan   [P~] src/config/resolve.ts:69-159   node:path.resolve at :152, :241, :291, :306 consults cwd when workspacePath is relative; see finding C2
│           │   ├─ deps.sources.prepare                      -> deployment-sources -> git-source-store
│           │   └─ deps.files.reservePorts                   -> runtime-files availablePort (binds 127.0.0.1)
│           ├─ persistTarget                                 [H] src/runtime/targets.ts:175-184
│           ├─ activateDeployment / stopForRecovery          [H] src/runtime/deploy.ts:7-102, 104-129
│           ├─ stopRecordedTarget                            [H] src/runtime/stop.ts:7-21
│           ├─ deps.lifecycle.up / down / retire             [H~] up, [H] down, [H] retire   src/runtime/lifecycle.ts:118-202, 203-258, 87-117
│           │   ├─ supervisor.ensureRunning({command: ["/bin/sh","-c",...], env: await effects.environment(...)})   :158-166
│           │   ├─ awaitReady(component, target, effects)    [H~] :262-297   owns a readyTimeout deadline timer :271-274 and a 100 ms poll :284; documented at :269
│           │   │   └─ effects.health(...)                   explicit capability; the concrete adapter does http at target-effects.ts:148
│           │   └─ effects.route(target)                     :172
│           ├─ projectStatus -> observeTargets -> aggregate  [H~][H~][P] src/runtime/project-status.ts:13-97, status.ts:50-178, 179-206   observeTargets owns a budget timer at status.ts:56 (documented at :49)
│           ├─ doctor / hostDoctor                           [H~] doctor inherits the observeTargets timer, [H] hostDoctor   src/runtime/doctor.ts:59-177, 10-36   config re-read per target at :103
│           ├─ deps.files.logs -> readTargetLogs             [O] src/adapters/target-log-reader.ts:58-134
│           ├─ in-place mutation of store records            :359-374 before persistTarget
│           └─ record(...).catch(() => {})                   :391, :420   diagnostic failures swallowed
├─ createConfigEditor({resolveProject, documents: {read, preview, apply: editProjectConfig}, exclusive})
│                                                            [H] src/daemon/config-editor.ts:156-248
│   ├─ schema / fields computed at import time               src/daemon/config-editor.ts:104, 145
│   └─ editProjectConfig                                     [O] src/config/documents.ts:286-347   lock :293, backup :309, temp :322, revision recheck :327-335, rename :336
├─ start(): runtime.reconcile(); setInterval(..., 5000)      [O] src/daemon/composition.ts:131-146
│   └─ runtime.exclusive(() => monitorRuntimeFailures({store, observations, now}))   [H~] src/runtime/activity.ts:15-102   owns a budget timer at :20; errors swallowed at composition.ts:145
└─ shutdown(): drain, child.shutdown, launchd.shutdown       src/daemon/composition.ts:150-157
```

Where honesty hits dishonesty in this subtree:

1. Runtime orchestration generally takes operational capabilities through `deps`; the concrete `FileStateStore` separately owns filesystem work. Among the orchestration functions, `observeTargets` (`status.ts:56`), `monitorRuntimeFailures` (`activity.ts:20`), and `awaitReady` (`lifecycle.ts:271-284`) own `setTimeout` deadlines directly. Each is documented as a deadline that a non-cooperating provider cannot extend, and each is bounded by an explicit parameter or config value, so they are honest deadline owners with an incomplete scheduling seam rather than hidden dependencies. Their callers (`projectStatus`, `doctor`, `createTargetLifecycle.up`) inherit that qualification and are marked `[H~]`.
2. `effects.health` is an explicit capability of `awaitReady` and `observeTargets`. The concrete adapter's global `fetch` at `src/adapters/target-effects.ts:148` is the declared job of that adapter, not an extra channel, and the http branch is proven by `tests/rig-e2e.test.ts` (asserts `healthy` around lines 47-67 against a real `http://127.0.0.1:${web.port}` probe) and `tests/full-project-e2e.test.ts` (`/health` route). The genuinely undeclared channel in that file is the clock in `recordOutput` at `:126`.
3. Five provider factories accept an optional `run` and default to the module-level `runCommand` (process identity `:10`, launchd `:23`, git source store `:24`, installer `:35`, Caddy router `:31`), and `composeDaemon` relies on the default for all but target effects, project documents, and deployment sources. For a concrete OS provider whose job is the OS, an ambient default is a legitimate convenience contract. The cost is local reasoning: a reader of `composition.ts` cannot tell from the call which providers share the injected runner's abort and timeout policy. Coverage of the defaults is uneven rather than absent: the child supervisor's defaults are exercised directly by `tests/providers-process.test.ts` (`createChildSupervisor({stateRoot: root})` at lines 16, 63, 106, 130, 152, 162, 186), the installer default by `tests/target-effects.test.ts:43-44`, and the whole shipped graph by `tests/rig-e2e.test.ts` and `tests/full-project-e2e.test.ts`, which launch the real `src/rigd.ts` as a subprocess. The launchd supervisor's real `launchctl` path and the git source store default are reached only through those e2e suites or not at all, and are marked `[?]`.
4. `child-supervisor.ts:456-459` calls the module-level `runCommand` directly inside `groupExists`, bypassing even the optional injection. That path fires only on `EPERM`, which no listed test provokes. This is a specifically identified provider branch with an incomplete substitution seam and unverified failure behavior.

## 7. Migration entrypoints that are library-only

`src/migration/index.ts` states that normal commands must not invoke migration implicitly. Source confirms it. The only production importer of any migration module is `src/daemon/composition.ts:5`, which wires `createAdoptionGuard(root)` into `createRuntime` as `assertOwnershipReady` at `:91`. Everything else is reachable only from tests.

| Entry | File | Reached from a compiled binary | Governing tests |
| --- | --- | --- | --- |
| `createAdoptionGuard(root)` | src/migration/adoption.ts:192-202 | Yes, via composeDaemon | tests/migration-adoption.test.ts, tests/migration-runtime-e2e.test.ts |
| `readLegacyAdoption(root)` | src/migration/adoption.ts:136-190 | No | tests/migration-adoption.test.ts |
| `finalizeLegacyAdoption(root, {expectedRevision, evidence})` | src/migration/adoption.ts:262-345 | No | tests/migration-adoption.test.ts |
| `validateEvidence` | src/migration/adoption.ts:203-260 `[P]` | No | via the above |
| `readLegacyState(root)` | src/migration/files.ts:121-126 | No | tests/migration.test.ts |
| `migrateLegacyState(...)` | src/migration/files.ts:145-285 | No | tests/migration.test.ts, tests/migration-runtime-e2e.test.ts |
| `convertLegacyState(...)` | src/migration/convert.ts:26-153 `[P]` | No | tests/migration.test.ts |
| `recoverSources(...)` | src/migration/source-evidence.ts:32-122 `[P]` | No | tests/migration.test.ts (by name, body not verified) |
| `adoptInstalledArtifact(...)` | src/adapters/artifact-ownership.ts:109-141 | No | tests/target-effects.test.ts, tests/migration-runtime-e2e.test.ts |

Classification: the file-touching migration functions are `[O]` and say so in their names and docs. `convertLegacyState`, `recoverSources`, and `validateEvidence` are `[P]`. No dishonest branch was found here, with the caveat that `buildPreview` at `src/migration/files.ts:288-358` performs `realpath`, `stat`, and `readProjectConfig` inside a function whose name suggests computation. Since no binary calls it, that is a naming nit rather than a runtime risk.

## 8. Coverage index

Depth is reported honestly. "Full" means every exported function in the area was read and placed in the tree. "Traced" means the main paths were read and leaf helpers were skimmed. "Named only" means the test file was listed by test title and its body was not read.

| Area | Files | Read depth | Dominant class | Gaps and unverified points |
| --- | --- | --- | --- | --- |
| Entrypoints | src/index.ts, src/rigd.ts, src/git/remote-helper.ts | Full | `[O]` | None. |
| CLI | src/cli/{rig,rigd,commands,interaction,output,failure,terminal-text,entry-environment,types}.ts | Full | `[H]` with `[P]` renderers | `entry-environment.ts` has no direct test. `commands.ts` is tested only through `cli.test.ts`. |
| Daemon | src/daemon/{host,server,client,composition,admin,config-editor,files,offline-doctor,protocol}.ts | Full | `[O]` | `composeDaemon` has no direct test; it is covered only by end-to-end fixtures through the compiled entrypoint. `offline-doctor.ts` is covered only by one deployment-e2e case. |
| Runtime core | src/runtime/{application,targets,projects,registration,status,project-status,doctor,deploy,stop,ports,activity,lifecycle,state-store,state-schema,contracts}.ts | Full | `[H]` with `[P]` helpers; `[H~]` where status.ts:56, activity.ts:20, and lifecycle.ts:271-284 own documented deadline timers | `execute` at application.ts:38-438 is long; branch by branch reading was done but not every early-return was matched to a test title. |
| Domain | src/domain/{errors,git,runtime}.ts | Full | `[P]` | None. |
| Config | src/config/{documents,resolve,schema,editor,types,errors,index}.ts | Full | `[P~]` resolvers, `[O]` document I/O | `resolveTargetPlan` is pure only when `workspacePath` is absolute; `ResolveTargetPlanInput` (types.ts:73-84) accepts plain strings and `node:path.resolve` consults cwd otherwise. `discoverProject` upward search behaviour on symlinked parents is covered by initialization-slug test by name only. |
| Diagnostics | src/diagnostics/{host-log,file-log,types}.ts | Full | `[O]` | `host-log.ts` has no test. Rotation and prune in file-log are tested (file-log.test.ts, 8 cases by name). |
| Adapters | src/adapters/{target-effects,effect-transactions,artifact-ownership,project-documents,deployment-sources,runtime-files,host-inspection,admin-activity,target-log-reader,terminal-interaction}.ts | Full | `[O]` | `prepare` dependency-install detection (target-effects.ts:288-302) was read, not matched to a test. |
| Providers | src/providers/{command-runner,child-supervisor,launchd-supervisor,git-source-store,artifact-installer,caddy-router,captured-process,capture-status,process-identity,contracts}.ts | Full | `[O]` | `process-identity.ts` has no direct test, but its default runner is exercised through `createChildSupervisor` defaults in providers-process. Launchd behaviour is tested with a fake runner only (providers-launchd injects `run` at line 34). The `EPERM` branch of `groupExists` is unverified. |
| Git | src/git/{remote-helper,remotes,project,preflight}.ts | Full | `[H]` over CommandRunner, except `inspectProjectGit` which is `[O]` (realpath at project.ts:26, :37) | `git-preflight.test.ts` uses `test.each` with two commit lengths and asserts no fetch; it exists and is real. `git-project.test.ts` uses real temp directories, so the realpath channel is exercised. `createGitPushSource` has no direct unit test. |
| Migration | src/migration/{index,types,adoption,convert,files,schema,source-evidence}.ts | Traced | `[O]` files, `[P]` conversion | `recoverSources` test body not read. |
| Tests | tests/*.test.ts, src/**/*.test.ts | Named only, except rig-fixture.ts and git-preflight.test.ts read in full, and targeted excerpts of rig-e2e, full-project-e2e, providers-process, providers-caddy, providers-git, providers-launchd, target-effects, runtime-status, daemon-admin, and cli.test.ts read during parent verification | | Trust marks below are based on test titles plus those bodies and excerpts. |

This review did not prove any function correct. It classified where effects enter and whether the signature admits them.

## 9. Ledgers for consequential boundaries

Each ledger records the caller's job, inputs, outputs and effects, ambient access, prerequisites and ownership, failure policy, and direct callees with a trust mark. Trust marks: `T` tested by a named public-behaviour test, `D` documented in a doc comment, `U` unverified.

### 9.1 `main` client closure, src/index.ts:37-69

- Job: turn a `RuntimeCommand` into a daemon result, or an offline doctor report when the daemon is absent.
- Inputs: `request`; closes over `root`.
- Outputs and effects: reads address and token files; one HTTP call to 127.0.0.1; for `doctor`, filesystem probes of the state root and repo.
- Ambient access: `process.cwd()` at :43 and :64.
- Prerequisites and ownership: `root` fixed at process start; address file may vanish between read and use.
- Failure policy: `DAEMON_MISSING` for no address; on `DAEMON_UNREACHABLE`/`DAEMON_MISSING` from the client, doctor degrades to offline inspection; everything else rethrown.
- Callees: `readDaemonAddress` U, `readDaemonToken` U, `DaemonClient.command` T (transport.test.ts), `inspectOfflineHost` T (deployment-e2e "offline doctor still reports daemon and independent config findings").
- Verdict: correct as far as read, but the duplicated closure re-reads cwd. Its full fallback matrix was not verified here; this is not a claim that the CLI entrypoint is untested.

### 9.2 `runDaemonHost` plus `startControlPlane`, src/daemon/host.ts:17-124 and src/daemon/server.ts:20-136

- Job: acquire single ownership of a state root, publish a localhost control plane, and stop cleanly.
- Inputs: `{root, port, handle, editor, start?, shutdown}`.
- Outputs and effects: lease and address files, a Bun server bound to 127.0.0.1, `process.exitCode`, signal handlers.
- Ambient access: `process.pid` (:31, server.ts:53), `process.kill(pid, 0)` (:125-132), `process.once` signals (:115-116).
- Prerequisites and ownership: lock file `wx` at acquisition; address rename after listen; lease removed on release.
- Failure policy: `DAEMON_START_LOCK`, `DAEMON_LEASE`, `DAEMON_RUNNING`; `start` failure calls `stop(1)`; shutdown failure leaves ownership evidence (comment at :102).
- Callees: `startControlPlane` T (transport.test.ts, git-push.test.ts), `options.shutdown` U, `processExists` U.
- Verdict: an honest effect owner. The `/health` pid is the only leak of host identity into the protocol.

### 9.3 `composeDaemon`, src/daemon/composition.ts:31-158

- Job: build the whole production object graph for one state root.
- Inputs: `root`, `captureCommand`.
- Outputs and effects: reads host config; constructs providers, adapters, store, runtime, editor; owns a 5 s monitor interval.
- Ambient access: `process.getuid` (:45), `process.env` (:55), `new Date` (:39, :84, :101, :141), `setInterval` (:133), `randomUUID`.
- Prerequisites and ownership: host config must parse; providers are shared singletons for the daemon lifetime.
- Failure policy: config failure propagates; monitor failures swallowed at :145.
- Callees: `createRuntime` T (runtime-application, 12 cases), `createTargetEffects` T (target-effects, 6 cases), `createChildSupervisor` T with defaults (providers-process, 11 cases), `createLaunchdSupervisor` T with fake runner only, `createCaddyRouter` T, `createGitSourceStore` T with injected runner, `createArtifactInstaller` T with defaults (target-effects.test.ts:43-44), `createConfigEditor` T (config-control-plane), `monitorRuntimeFailures` T (activity-crashes).
- Verdict: the right place for ambient acquisition. No unit test constructs this graph directly, but `tests/rig-e2e.test.ts`, `tests/full-project-e2e.test.ts`, `tests/daemon-admin.test.ts`, and the `rig-fixture` suites launch the real `src/rigd.ts` subprocess, so the shipped graph is exercised end to end in process mode. What remains unverified is the launchd supervisor against real `launchctl`. The mix of explicit `now`/`runCommand` for some children and defaults for others is a consistency cost, not a contract violation.

### 9.4 `createRuntime(...).command`, src/runtime/application.ts:461-467 and execute :38-438

- Job: serialize mutating commands, run reads concurrently, and persist every transition.
- Inputs: `RuntimeCommand` (zod-validated by the server) plus `RuntimeDependencies`.
- Outputs and effects: state store updates; lifecycle effects; diagnostic records.
- Ambient access: none directly. Everything flows through `deps`.
- Prerequisites and ownership: records returned by `store.read` are mutated in place (:359-374) and then persisted; the queue at :461-467 guarantees no concurrent mutator, but reads run against whatever object the last read returned.
- Failure policy: tagged `RigError`; failure recorded with `errorCode` then rethrown; diagnostic failures swallowed (:391, :420).
- Callees: `selectProject` T (project-registration), `planTarget` T (runtime-application), `activateDeployment` T (deployment-effects, 16 cases), `lifecycle.up/down` T (runtime-lifecycle), `projectStatus` T (runtime-status), `doctor` T (runtime-review-regressions).
- Verdict: honest and well covered. In-place mutation before persist is a local-reasoning cost, not a correctness bug on the evidence read.

### 9.5 `createTargetLifecycle(effects).up`, src/runtime/lifecycle.ts:118-202

- Job: bring every component of a target to running, in dependency order, under a checkpoint.
- Inputs: `target`, optional `providedCheckpoint`.
- Outputs and effects: through `effects` only: supervisor start, hooks, health polling, routing, checkpoint commit or rollback.
- Ambient access: `awaitReady` owns `setTimeout` deadlines (:271-274, :284) bounded by `component.readyTimeout` from config and documented at :269. This is a deadline effect owner inside an honest module, so `up` is `[H~]`. `effects.health` is an explicit capability; the concrete adapter's http probe is that adapter's declared effect.
- Prerequisites and ownership: `assertProviderProfile` (:310-318); checkpoint scope check `EFFECTS_SCOPE` (:121).
- Failure policy: `PROCESS_UNKNOWN`, `HEALTH_FAILED`, `START_ROLLBACK_FAILED`; rollback on any failure when it owns the checkpoint.
- Callees: `effects.supervisor` T, `effects.environment` T, `effects.health` T for the http branch (rig-e2e asserts `healthy` with `health: http://127.0.0.1:${web.port}`; full-project-e2e uses a `/health` route), `effects.route` T (providers-caddy), `checkpoint.commit/rollback` T (deployment-effects).
- Verdict: honest orchestration with a documented deadline timer. No unverified leaf remains on the http path.

### 9.6 `createTargetEffects(...).install` and `.route`, src/adapters/target-effects.ts:338-402 and 403-426

- Job: publish an artifact under ownership and expose the target through the router.
- Inputs: target and component records.
- Outputs and effects: build via installer, ownership publish, receipt write, artifact capture into the checkpoint, Caddyfile change.
- Ambient access: installer's `Bun.which("bun")` (artifact-installer.ts:66) when `bunExecutable` is omitted, which composition omits.
- Prerequisites and ownership: `ownership.inspect` must not report `ARTIFACT_CONFLICT`; route requires a recorded port (`ROUTE_UPSTREAM`).
- Failure policy: `BUILD_FAILED`, `ARTIFACT_*`, `ROUTE_*`; router rollback on reload failure (caddy-router.ts:130-145).
- Callees: `createArtifactOwnership` T (target-effects.test.ts), `createEffectTransactions` T (deployment-effects), `installer.build` T (providers-installer with fake runner), `router.apply` T (providers-caddy).
- Verdict: good boundary with one ambient PATH lookup that should be a composition-time input.

### 9.7 `DaemonAdmin.performUninstall`, src/daemon/admin.ts:179-251

- Job: stop the daemon and remove its installation without stranding targets.
- Inputs: none beyond constructor options.
- Outputs and effects: `prepare-uninstall` command to the daemon, launchctl bootout or SIGTERM, marker and plist removal, `cancel-uninstall` on failure.
- Ambient access: `process.kill` (:227), `Date.now` (:228-229), `process.getuid` (:289), raw `Bun.spawn` for launchctl (:300).
- Prerequisites and ownership: the daemon must confirm safety (`DAEMON_UNCERTAIN`).
- Failure policy: `DAEMON_STOP` after the deadline; compensating `cancel-uninstall` with its own failure swallowed (:238).
- Filesystem effects: removes the install marker and, in launchd mode, the plist under `userHome/Library/LaunchAgents`; appends to the admin activity journal; startup log is opened by install, not uninstall.
- Callees: `DaemonClient.command` T, `processExists` T in process mode, `launchctl` U (no test exercises real launchctl; launchd mode is unverified). The process-mode sequence including `cancel-uninstall` on a failed stop is covered by daemon-admin "failed daemon stop cancels uninstall quiescence and preserves installation".
- Verdict: correct sequencing on the evidence in process mode. The raw spawn is the design deviation and the launchd branch is the unverified one.

### 9.8 `editProjectConfig`, src/config/documents.ts:286-347

- Job: apply validated edits to a project config atomically, with a revision check.
- Inputs: path, expected revision, edits.
- Outputs and effects: `.lock` (`wx`), `.<revision>.bak` (`wx`, 0o600), temp file with `randomUUID`, revision recheck, rename, cleanup.
- Ambient access: `randomUUID` for the temp name; otherwise all paths derive from inputs.
- Prerequisites and ownership: caller holds `runtime.exclusive` (config-editor wiring at composition.ts:122).
- Failure policy: revision mismatch fails before rename; lock left on crash is a known operator step (hint text).
- Callees: `applyYamlEdits`/`applyJsonEdits` P, `yamlDocument` P, `parseProjectConfig` P.
- Verdict: an exemplary effect owner. Tested by config-control-plane and config-http-e2e by name.

### 9.9 `FileStateStore.update`, src/runtime/state-store.ts:64-82

- Job: serialize one mutation of the state file behind an in-process queue and replace the file atomically. The class doc at :14 declares it a filesystem adapter with one daemon as writer.
- Inputs: a mutator callback over the parsed state; `root` from the constructor.
- Outputs and effects, all under `root/runtime`: `this.read()` at :66 performs `readFile` of `state.json` (:25) and, on `ENOENT`, `access` probes for legacy `rigd-state.json` and `registry.json` (:28-43); `mkdir` with mode 0o700 (:69); `writeFile` of `state.json.next` with mode 0o600 (:72-74); `rename` over `state.json` (:75); `rm` of the temp file in `finally` (:77). The callback's own effects are inherited by the call.
- Ambient access: none beyond the filesystem under `root`. No clock, no environment.
- Prerequisites and ownership: an in-process promise queue (:16, :65, :80) serializes updates within one daemon. There is no lock file, no backup, and no revision check. Cross-process exclusion comes from `runDaemonHost` ownership, not from this class. Callers must not hold references to the pre-update object across the call (see 9.4).
- Failure policy: `LEGACY_STATE_PRESENT` when legacy files exist and no new state does; `STATE_READ` for other read errors; `STATE_CORRUPT` when parse or schema fails on read; schema invariants (state-schema.ts:123-176) are re-checked at :68 before any write; a failed update is dropped from the queue chain at :80 so later updates proceed.
- Callees: `runtimeStateSchema.parse` P, `node:fs/promises` primitives.
- Verdict: an intentional filesystem adapter, `[O]`, with a clear job. Tested by state.test.ts (3 cases by name). It is a simpler scheme than the config editor's lock, backup, and revision check, and that is appropriate because it has a single writer.

### 9.10 `createChildSupervisor(...).stop`, src/providers/child-supervisor.ts:178-234

- Job: stop an owned process group, verifying identity before signalling.
- Inputs: managed process key.
- Outputs and effects: SIGTERM then SIGKILL to the group; lease removal.
- Ambient access: `Date.now` (:213, :218), `Bun.sleep`, `process.kill`, module `runCommand` on the `EPERM` path (:456-459), and the default identity reader's `/bin/ps`.
- Prerequisites and ownership: lease must match live identity (`PROCESS_UNKNOWN` at :190, re-verify at :202-209).
- Failure policy: `STOP_TIMEOUT`.
- Filesystem effects: lease file removal under `stateRoot/process-leases`.
- Callees: `inspect` T through the default reader (providers-process builds the supervisor with defaults, so real `/bin/ps` is exercised), `groupExists` U on the EPERM branch.
- Verdict: correct by design, hard to test on its permission-error branch.

### 9.11 `runRemoteHelper` push batch, src/git/remote-helper.ts:67-229

- Job: implement the git remote-helper protocol over stdin and hand each push to the daemon.
- Inputs: `url`, `{repoPath, input, output, newOperationId, source, diagnostics, client}`.
- Outputs and effects: writes protocol lines to `output`; one daemon command per push; diagnostics.
- Ambient access: none in this function.
- Prerequisites and ownership: `input` is consumed once; the caller owns the readline interface.
- Failure policy: protocol errors reported per ref; daemon errors rendered with hint.
- Callees: `projectFromRemote` P, `parsePush` P, `source.*` T (git-push.test.ts), `client.command` T (git-remote-helper.test.ts with fake client).
- Verdict: the model boundary in this codebase.

## 10. Findings by class

### Correctness

No wrong state transition was found in the paths traced. Three result-channel items are recorded:

- C1. `registerProject` catch at `src/runtime/projects.ts:103-110` rethrows `REGISTRATION_INCOMPLETE` and discards the original error. If the store rejected because of a schema invariant, the operator sees a generic message and the diagnostic log records `REGISTRATION_INCOMPLETE`, not the real code. State is preserved, but failure information the skill says to keep is lost.
- C2. `resolveTargetPlan` (`src/config/resolve.ts:69-159`) is documented at :65-67 as resolving without reading files or allocating ports, and it does neither. It does consult the current working directory: `node:path.resolve` at :152, :241, :291, and :306 resolves `envFile`, sqlite `path`, and installed `entrypoint` against `input.workspacePath`, and when that value is relative the result depends on `process.cwd()`. The parent orchestrator reproduced this with `workspacePath: "work"`, obtaining different absolute entrypoints from two processes with different cwd. `ResolveTargetPlanInput` (`src/config/types.ts:73-84`) admits plain strings, so the API admits the hidden read. The inspected normal production paths provide absolute inputs: `planTarget` passes `project.repoPath` (realpath'd by `inspectProjectGit` or `inspectInitialization`) or a workspace under `join(deps.root, ...)` where `deps.root` comes from `rigRoot()`, which calls `resolve`; `repoint` passes a `discoverProject` result, which realpaths; `doctor` passes the recorded plan's path. So the function is `[P~]`: pure over the absolute-path domain the runtime uses, dishonest at its own signature.
- C3. `observeTargets` `withinDeadline` (`src/runtime/status.ts:57-70`) resolves the same fallback for two different events: the deadline abort (:64-67) and a rejected provider promise (`work.then(resolve, () => resolve(fallback))` at :69). The fallback passed at :154-159 carries `reason: "Observation did not complete before the status deadline."`. A provider that throws immediately therefore reports `unknown` with a reason that claims a timeout. The `unknown` state is the safe outcome and no raw error text is exposed, so this is a misleading reason string, not an unsafe state. `monitorRuntimeFailures` `observeBeforeDeadline` (`src/runtime/activity.ts:104-120`) has the same two-into-one shape but attaches no reason, so it misleads nobody. The status test "one deadline bounds every concurrent probe and timeouts are unknown" (`tests/runtime-status.test.ts:54-78`) covers the hanging case only; no listed test rejects a provider promise.

### Local reasoning and testability

- T1. Five provider factories default `run` to the module `runCommand` (`process-identity.ts:10`, `launchd-supervisor.ts:23`, `git-source-store.ts:24`, `artifact-installer.ts:35`, `caddy-router.ts:31`), and `composeDaemon` relies on those defaults for four of them. This is a legitimate convenience contract for concrete OS providers. The precise cost is that the signature does not distinguish an explicit runner from the ambient one, so a reader of `composition.ts` cannot see which providers share the injected runner's abort, timeout, and output-cap policy, and a future change to `runCommand` defaults silently changes some providers and not others. Coverage is uneven, not absent: child supervisor defaults are unit-tested, the installer default is unit-tested, and the shipped graph runs under rig-e2e and full-project-e2e. The launchd supervisor with real `launchctl` and the git source store default are unverified `[?]`.
- T2. `child-supervisor.ts:456-459` calls the module `runCommand` directly inside `groupExists`, on the `EPERM` branch only. No injection point exists for that call and no listed test provokes `EPERM`.
- T3. `createHostDiagnosticLog` (`src/diagnostics/host-log.ts:7-21`) documents its lazy Host-policy read, so the read itself is honest. The fallback at `:16` discards the reason the read failed and emits nothing, so a broken host config produces default diagnostics with no evidence. No test drives the invalid-config fallback for the CLI or remote helper.
- T4. `followLogs` (`src/cli/rig.ts:85`) picks the module timer when `wait` is absent, and `main` never supplies it, so `followLogs` is `[H~]` and the default timer is a hidden channel. The follow behaviour is tested with an injected `wait` only; no end-to-end suite passes `--follow`.
- T5. Uninjected clocks: `target-effects.ts:126` (`recordOutput` timestamps) is the one that is undeclared, since `createTargetEffects` has no clock option. `child-supervisor.ts:67` and `admin.ts:55-59` offer `now` or `activity` overrides and default to the real clock, which is a documented convenience in an OS adapter. `createRuntime` and `createAdminActivityJournal` in composition receive an explicit `now`, so the convention exists and is applied unevenly.
- T6. `execute` mutates store records in place (`application.ts:359-374`) and `updateRegistration` assigns `project.name` on the caller's object after the store update at `:55` succeeds (`registration.ts:73`). Both are intentional under the mutation queue and consistent on the evidence read. The cost is that the reader must know about the queue and the ordering to believe it.
- T7. `config-editor.ts:104` and `:145` compute schema-derived tables at import time. Importing the module has a cost and a failure mode that no function signature shows.

### Caller usability

- U1. The daemon client closure is duplicated between `src/index.ts:37-69` and `src/git/remote-helper.ts:339-353` with different fallback behaviour. A named `createDaemonClientFromRoot(root, {cwd})` would give both callers the same tested object and remove the second `process.cwd()` read.
- U2. `DaemonClient` hard-codes 1500, 5000, and 300000 ms at `client.ts:30-36` and `:42`. Callers cannot shorten a status probe or lengthen a deploy without editing the class.
- U3. `prepareInteractiveRequest` reports the detached-HEAD warning through `deps.output.error` (`interaction.ts:152-155`) instead of returning it. The caller cannot render it differently for `--json` and tests must scrape stderr.
- U4. `doctor` re-reads project config once per target (`doctor.ts:103`). For a project with several targets the same file is parsed repeatedly and a mid-run edit produces inconsistent findings.

### Optional design improvement

- O1. `DaemonAdmin.launchctl` (`admin.ts:299-316`) spawns `/bin/launchctl` with `Bun.spawn` directly. Every other subprocess in the codebase goes through `CommandRunner`. Routing this through the same interface would make `performUninstall` testable with a fake and remove the only raw process API outside `command-runner.ts` and `child-supervisor.ts`.
- O2. `/health` exposes `process.pid` (`server.ts:53`). The daemon already writes an owner record with pid; the protocol could carry `instanceId` only.
- O3. `inspectHost` and `createArtifactInstaller` both call `Bun.which` (`host-inspection.ts:43`, `artifact-installer.ts:66`). A single `ToolLocator` capability created in composition would make PATH an explicit input.
- O4. The two launchd label schemes (`composition.ts:46` uses `com.b-relay.rig.<sha256>` for targets, `admin.ts:286` uses `com.b-relay.rigd.<Bun.hash>` for the daemon) are intentional but undocumented next to each other. One shared `labels.ts` with both constructors and a comment would prevent a future collision.

## 11. Concrete improvements

The strongest priorities are the status reason defect (5a) and resolver prerequisite (5b). Other items are focused testability or readability options; the numbering preserves finding references.

1. Optional consistency: have `composeDaemon` pass `run: runCommand` and `now` to every provider it constructs so a reader of composition sees one policy. Keeping the factory defaults is acceptable for direct provider use; the point is that composition should not rely on them. No behaviour change.
2. Add an `inspect` runner parameter to `groupExists` in `child-supervisor.ts` so the `EPERM` branch uses the injected runner.
3. Extract the daemon client closure into `src/daemon/client-factory.ts` taking `{root, cwd, offlineDoctor?}` and use it from both `index.ts` and `remote-helper.ts`.
4. Keep the documented lazy read in `createHostDiagnosticLog`, and record one entry describing the fallback when host config fails to parse, so the degraded mode leaves evidence.
5. Pass `wait` from `main` in `index.ts` and remove the module default in `rig.ts`, or keep the default but document it in `CliDependencies` as the production timer.
5a. In `observeTargets`, give `withinDeadline` two fallbacks or a reason parameter so a rejected provider promise reports a provider-failure reason and only the abort reports the deadline. Keep the state `unknown` in both cases and keep raw error text out of the report.
5b. Either narrow `ResolveTargetPlanInput.workspacePath` and `dataRoot` to a branded absolute-path type produced by the realpath sites, or assert `isAbsolute` at the top of `resolveTargetPlan` and throw a `ConfigError`. The first option carries the invariant in a type, which the interfaces reference prefers when several boundaries rely on it.
6. Add a `clock` option to `createTargetEffects` for `recordOutput`, and pass `now` to `createChildSupervisor` from composition.
7. Preserve the cause in `registerProject`: attach the original error as `details.cause` or rethrow the original `RigError` when it already is one.
8. Return the detached-HEAD note from `prepareInteractiveRequest` as part of its result and let `execute` decide how to render it.
9. Move `launchctl` behind `CommandRunner` in `DaemonAdmin`.

## 12. Missing public-behaviour tests

Named by the behaviour they would prove, with the boundary they govern.

- `resolveTargetPlan` produces the same plan for the same input regardless of the calling process's working directory, or rejects a relative `workspacePath` with a tagged error. Governs C2.
- `observeTargets` reports a component whose provider throws as `unknown` with a reason that does not claim the deadline expired, while a hanging provider still reports the deadline reason. Governs C3.
- Host diagnostic log still records an entry when host config is present but invalid, and that entry or a companion entry names the fallback. Governs T3.
- `rig logs --follow` through the compiled entrypoint stops within one poll interval after SIGINT. Governs T4, which today is covered only with an injected timer.
- `registerProject` surfaces the underlying store error code in `details` when the state update fails. Governs C1.
- Child supervisor `stop` on a process group that returns `EPERM` from `kill` still reaches a decision through `ps -g`. Governs T2. This needs a fixture that can provoke `EPERM`, which may not be possible in CI; if not, record it as accepted-unverified.
- `DaemonAdmin.uninstall` in launchd mode issues `bootout` and, on failure, `cancel-uninstall`. Governs O1 and the launchd branch of ledger 9.7. Process mode is already covered.
- Doctor reads each project config once per run regardless of target count. Governs U4.

Removed after parent verification: a test that composition passes a fake runner to every provider (that asserts wiring, not public behaviour), a test for http health through an injected fetch (rig-e2e and full-project-e2e already prove the http branch), and a test for rename ordering (the ordering is intentional and consistent on the evidence).

Tests that already govern boundaries and should be run after any of the changes above:

```
bun test tests/transport.test.ts tests/state.test.ts tests/daemon-admin.test.ts \
  tests/git-remote-helper.test.ts tests/git-push.test.ts src/cli/cli.test.ts \
  tests/runtime-application.test.ts tests/runtime-lifecycle.test.ts \
  tests/deployment-effects.test.ts tests/target-effects.test.ts \
  tests/providers-process.test.ts tests/providers-caddy.test.ts \
  tests/config-control-plane.test.ts tests/activity-crashes.test.ts
```

## 13. Boundaries that are already good

- `runRigdCli` and `runRemoteHelper` take their operational capabilities through dependency objects. `runRigCli` mostly follows that pattern, with the optional wait fallback described above. Their entrypoints concentrate host acquisition, though the client closure repeats cwd acquisition.
- Runtime orchestration uses `RuntimeDependencies`, with documented ambient deadline timers inside several operations. `FileStateStore` is a separate filesystem owner in the same directory; caller verdicts also inherit the resolver prerequisite below. `resolveTargetPlan` neither reads files nor allocates ports, as its doc at `resolve.ts:65-67` says, and is pure over the absolute paths the runtime hands it (see C2 for the signature gap). `targetName`, `recordedPorts`, `aggregate`, `configuredComponents`, and the state-schema invariants are pure and cheap to test.
- Git helpers (`remotes.ts`, `preflight.ts`, `createGitPushSource`) take a `CommandRunner` explicitly and are fully substitutable. `git-preflight.test.ts` asserts the command list and proves no fetch occurs. `inspectProjectGit` and `ensureProjectGit` in `project.ts` are the exception: they also call `realpath`, which is the right behaviour for path discovery but means a fake runner alone does not isolate them.
- `editProjectConfig` is a textbook multi-writer atomic editor: lock, backup, temp, revision recheck, rename, cleanup. `FileStateStore.update` is a simpler single-writer atomic replace: in-process queue, temp, rename, cleanup, with schema validation before the write. Each scheme matches its ownership model.
- `createEffectTransactions` gives lifecycle a checkpoint object with `commit` and `rollback`, and lifecycle refuses a checkpoint for a different target (`EFFECTS_SCOPE`). That is a proof value in the sense of the interfaces reference.
- The control plane validates every request with zod (`protocol.ts`), binds to 127.0.0.1 only, and compares tokens in constant time.
- `readTargetLogs` uses inode identity and an opaque cursor, and `followLogs` in the CLI treats the cursor as opaque, so the protocol boundary does not leak file layout.
- The migration package is genuinely isolated. Only the adoption guard enters the daemon, and it enters through an explicit `assertOwnershipReady` dependency.

## 14. Conclusion

The codebase separates honest orchestration from effect ownership well. The runtime core, the CLI runners, and most git helpers are honest and are tested through their public signatures, and the shipped daemon graph is exercised end to end by suites that launch the real `rigd`. Effect owners are named as such and sit at the edges, and several of them (the lazy diagnostic log, the provider `run` defaults, the health adapter) are documented design choices rather than hidden contracts.

The genuinely dishonest points are few and specific: `resolveTargetPlan` admits relative paths and then consults `cwd`, `followLogs` reaches a default timer that `main` never replaces, `recordOutput` timestamps with an undeclared clock, `inspectProjectGit` has a `realpath` channel beside its runner, `groupExists` reaches the module runner on its `EPERM` branch, while the duplicated daemon client closure is a separate readability concern, not dishonesty merely because it is anonymous. The one result-channel correctness finding is that `observeTargets` reports a provider failure with a deadline reason. The inspected normal production paths supply absolute resolver inputs, and the `unknown` state on the status path is safe, so none of these was shown to produce a wrong runtime action.

This review read every source file under `src/` and classified the functions that appear in the trees above. It did not execute tests, did not prove any function correct, and relied on test titles plus targeted excerpts for trust marks. Counts of functions per class are deliberately omitted because the trees prioritize meaningful paths over an exhaustive enumeration.
