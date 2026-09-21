# Function honesty tree — independent review A

Reviewed checkout: `f6d48fe3fc7b0d3b4473bebcb8fae4e577cf4b9f`, September 9, 2026. Source review only; no application files changed and no tests run. I read the function-design skill and its three references, independently of reviewer B.

## Assessment

Rig has a substantial, useful separation between commands, runtime orchestration, and concrete effects. Its strongest boundaries are explicit runtime dependencies, pure policy helpers, data-preserving errors and compensation, and adapters that own filesystem/process/network work. It is not a uniformly dishonest codebase. Nor does putting `effects` in a parameter prove an entire subtree honest.

The main weaknesses are narrower and actionable:

1. `observeTargets` reports immediate adapter rejection as deadline expiry: an observable result-contract defect.
2. The advertised pure plan resolver admits relative paths, which let `node:path.resolve` read process working directory: an unexpressed prerequisite with transitive consequences.
3. Git discovery accepts an injected command runner while independently acquiring filesystem identity: a partially substitutable boundary.
4. Runtime deadline owners are explicit about being bounded, but their scheduling source is ambient. Their injected effects cannot control the complete operation in isolation. This is timing-seam debt, not evidence that using deadlines or async effects is inherently dishonest.

Several shared interfaces also return `unknown` or omit consequential failure/ownership details. This makes their contracts less exact even where their dependencies are sensibly separated.

This is a boundary-focused assessment, not an exhaustive function census or a numerical code-quality score. I inventoried all **79 production TypeScript modules**, traced the main command and runtime paths, and examined consequential bodies and relevant tests. The coverage index distinguishes that depth from files only scanned. There are no grounds here for claiming that every private helper has passed all eight skill steps.

## Legend and interpretation

- **H**: inspected value calculation or explicitly authorized mutation; no hidden variable input/effect found in the stated domain.
- **C**: explicit capability composition. Effects, blocking, errors, and callback mutation remain part of the composed operation. Honest only to the extent the supplied capability's contract describes them; this is not a claim of purity.
- **O**: deliberate outside-world owner: entrypoint, transport, filesystem/process adapter, or documented deadline owner. Technically dishonest under the skill's strict definition, but often the correct place for that dishonesty.
- **D**: an interior dependency or prerequisite is hidden, rather than clearly contained at an effect owner.
- **T**: inherited debt from a direct callee; the propagation path is shown.
- **?**: scanned or delegated to a dependency whose full behavior was not verified here.

A factory is not automatically effectful merely because it returns an effectful method. Trees below attach the classification to the invoked method where possible. Receiver/closure state created from supplied dependencies is explicit instance state, not automatically an illicit global. Immutable lookup tables and schemas are treated as fixed policy. Routine allocation and native-library implementation details are outside the practical observation boundary.

## The call trees

These are execution/capability trees, not import trees. Siblings can run on different command branches. Repeated leaves refer to the same implementation, and `→` names the first relevant boundary.

### Normal CLI and remote-helper roots

```text
O src/index.ts:10 main(args)
  O rigRoot/userOutput (cli/entry-environment.ts:5,8)
    process.env, homedir, cwd; terminal writes
  O acquire signals, randomUUID, diagnostic clock, terminal streams
  C/T runRigCli(args, dependencies) (cli/rig.ts:10)
    C prepareInteractiveRequest(request, deps) (cli/interaction.ts:34)
      supplied client + interaction + AbortSignal
    C createRigCommand(cwd, output, execute) (cli/commands.ts:19)
      H grammar/request construction, conditional on absolute supplied cwd
      ? Commander parser internals (integration-tested; not audited internally)
    C recordDiagnostic(log, entry) (cli/failure.ts:33)
    C dependencies.client.command(request)
      O entrypoint's daemon discovery/fallback closure (index.ts:38)
        O readDaemonAddress/readDaemonToken (daemon/files.ts:50,57)
        O DaemonClient.command → request → fetch (daemon/client.ts:37,48,55)
        O inspectOfflineHost → inspectHost/discoverProject when daemon absent
    H renderResult/renderLogs (cli/output.ts:2,100)
    C output.write / reportFailure's output.error
    C/D followLogs (cli/rig.ts:78)
      supplied wait → C if provided
      → D default wait → ambient setTimeout (cli/rig.ts:86,95,103)

O src/git/remote-helper.ts:312 main(args)
  O acquire process.cwd/stdin/output, operation IDs and diagnostic clock
  D inspectProjectGit(path, runCommand) → realpath (git/project.ts:22,26,37)
  C runRemoteHelper(url, dependencies) (git/remote-helper.ts:67)
    H projectFromRemote / parsePush / oneLine (230,240,255)
    H targetName (runtime/targets.ts:9)
    C source.verifyBranch / source.resolve
      C createGitPushSource(repoPath, run) methods (git/remote-helper.ts:266)
        supplied runner; no additional filesystem acquisition in these methods
    C client.command (explicit network/deployment capability)
    H validate status/commit/completed reply shapes
    C output protocol frames + diagnostics + operation ID
```

The remote-helper protocol function is a good example: it accepts its stream, source resolver, daemon client, outputs, and operation-ID source. No direct cwd, clock, network, or process acquisition was found in `runRemoteHelper`. The surrounding executable owns those resources. The incomplete boundary is the separately called Git discovery helper, not the protocol loop.

### Daemon root, runtime, lifecycle, and observations

```text
O src/rigd.ts:10 main(args)
  O process.env, homedir, capture subprocess mode
  C runRigdCli(args, dependencies) (cli/rigd.ts:14)
    C supplied admin / output / diagnostics / operation IDs
      O DaemonAdmin install/status/uninstall (daemon/admin.ts:48)
        filesystem, daemon discovery, process/launchd control, timers, env
  O composeDaemon(root, captureCommand) (daemon/composition.ts:31)
    O load host config; select adapters; acquire environment, clocks, IDs
    C/T createRuntime(deps).command (runtime/application.ts:35,460)
      C explicit queue and draining state; explicit ownership guard
      C store.read/update → O FileStateStore (runtime/state-store.ts:15)
      C/T registerProject / selectProject (runtime/projects.ts:56,8)
        C documents initialization/discovery/read
          O createProjectDocuments methods (adapters/project-documents.ts:18)
            O config file operations
            D inspectProjectGit's separately acquired realpath
        D? resolve(path) if a supplied/stored path is relative
      C planTarget (runtime/targets.ts:34)
        H targetName / recordedPorts
        C sources.prepare/currentBranch, files.reservePorts, store, now, id
        C documents.resolve → D? resolveTargetPlan relative-path case
      C/T activateDeployment (runtime/deploy.ts:7)
        C checkpoint / persistTarget / stopForTransition / retireSuperseded
        C/T lifecycle.up(candidate, checkpoint)
          H assertProviderProfile (runtime/lifecycle.ts:310)
          C supplied checkpoint/prepare/supervisor/environment/install/hooks
          → O/T awaitReady (runtime/lifecycle.ts:262)
            C supplied effects.health(component,target,signal)
            ambient timeout and polling scheduler (271,284)
          C supplied route / checkpoint commit or rollback
        C explicit recovery state and commit decision persistence
      C lifecycle.down / retire (runtime/lifecycle.ts:203,87)
        C supplied supervisors, hooks, routes, effect checkpoints
        expected process failures and hook failures remain distinct
      C/T projectStatus / doctor / updateRegistration
        → O/T observeTargets (runtime/status.ts:50)
          ambient shared deadline (56)
          C process/health/artifact/persistent observation capabilities
          H aggregate reports (179)
          D result distinction: rejection is rendered as deadline expiry (71,156)
    O composeDaemon.start interval callback (daemon/composition.ts:128)
      C runtime.exclusive (queue and ownership proof)
      → O/T monitorRuntimeFailures (runtime/activity.ts:15)
        C store, observations, now
        ambient shared timeout (20)
        C observeBeforeDeadline(callback,signal) (104)
        H crash identity and duplicate/race filters, then C store.update
  O runDaemonHost(options) (daemon/host.ts:17)
    filesystem lease, PID/UUID, listeners, address publication, shutdown
    O startControlPlane(options) (daemon/server.ts:20)
      O HTTP request handler; health reply acquires process.pid (53)
      H authentication and request parsing
      C supplied runtime handle / config editor
```

`awaitReady`, `observeTargets`, and `monitorRuntimeFailures` say they own bounded operations. Their timers therefore are not covert unrelated I/O. They nevertheless form interior ambient islands below factories presented as dependency-injected orchestration. Their complete timing behavior is not substitutable through the current signatures. The tree marks this explicitly instead of calling the entire runtime pure or treating a purposeful effect owner as a correctness bug.

`createRuntime` captures an explicit queue and dependency object. It does not need a parameter for every local variable. Its status/doctor/registration branches inherit `observeTargets`' timing and failure-channel behavior; lifecycle activation inherits `awaitReady`'s scheduling. Merely wrapping those calls in closures does not contain the dependencies.

### Concrete effect leaves and the config/migration trees

```text
C runtime lifecycle/observation interfaces
  O createTargetEffects(options) methods (adapters/target-effects.ts:55)
    C selected Supervisor / CommandRunner / ArtifactInstaller / Router
    O environment → readEnvironment (493)
    O health → fetch for HTTP; supplied runner for command probes (148,155)
    O runTarget → recordOutput → filesystem + wall clock (99,114,126)
    O createArtifactOwnership / createEffectTransactions
      files, revisions, journals, compensation and guarded restoration
    H installedPath / installationPolicyKey (37,572)
  O createChildSupervisor(options) methods (providers/child-supervisor.ts:57)
    OS spawn/signals, leases, output files, restart and stop timers
    C optional now/identity reader, but these do not replace every OS channel
    O waitForCaptureStart (providers/capture-status.ts:35)
  O createLaunchdSupervisor(options) methods (providers/launchd-supervisor.ts:22)
    C runner; O plist/request files and polling
    H launchdPlist / xml (185,177)
  O createGitSourceStore / createArtifactInstaller / createCaddyRouter
    filesystem + optional runner defaults, UUIDs and OS capability lookup
    H Git-commit predicate / shell quoting / route marker calculations
  O createRuntimeFiles.reservePorts (adapters/runtime-files.ts:6)
    O availablePort → localhost bind then close (28)
    does not keep a socket reservation alive after returning
  O readTargetLogs (adapters/target-log-reader.ts:58)
    O readSource → files; H decodeCursor/parseLine/compareEntries

C createConfigEditor(dependencies) request handler (daemon/config-editor.ts:156)
  H schema/path validation, field descriptions and structured diffs
  C resolveProject / documents.read,preview,apply / exclusive
    O config/documents.ts file operations
      H decodeDocument / prepareEdit (112,247)
      H applyYamlEdits / applyJsonEdits (config/editor.ts:19,68)
        explicitly mutate caller-supplied private document; may partially edit on error
      O revision checks, backup, temporary file, publication

C runtime.registerProject → documents.initialize
  O initializeProjectConfig (config/documents.ts:208)
    H scaffoldProjectConfig (363), then O write new YAML

C runtime planTarget/doctor/updateRegistration → documents.resolve
  D? resolveTargetPlan (config/resolve.ts:69)
    H parseProjectConfig / interpolate / resolveHooks / dependencyOrder
    → D? resolveComponentProperties → resolve(workspacePath,path) (162,236)
    → D? resolvePlanComponent → resolve(workspacePath,...) (255,288,304)
    → D? resolve(workspacePath,envFile) (151)
    hidden cwd only when all participating paths are relative

O active runtime adoption guard (migration/adoption.ts:192)
  O readLegacyAdoption(root) → manifest and backup files (136)
  H parseManifest / validateEvidence (128,203)

Library-only migration operations (no normal command-tree invocation found)
  O readLegacyState / migrateLegacyState (migration/files.ts:121,145)
    O loadSources / buildPreview (77,288): current filesystem evidence
    H recoverSources (migration/source-evidence.ts:32)
    H* convertLegacyState (migration/convert.ts:26)
      H resolveProjects / convertPlan / orderComponents / planAdoption
      * recorded absolute-path validation bounds resolve's cwd behavior
    O explicit backup, revision protection, adoption journal and publication
  O finalizeLegacyAdoption (migration/adoption.ts:262)
```

Config editor read/preview/apply uses document decoding and edit validation; it does not call plan resolution. The separate plan-resolution subtree is reached through the runtime's `documents.resolve` capability.

The `buildPreview` name does not make migration preview pure: it checks current repository files after converting recorded data. That is acceptable within the migration filesystem owner. Conversely `recoverSources` clones supplied evidence and produces explicit issues; it is a strong value-oriented boundary. Migration exports and installed-artifact adoption helpers are compatibility/library surfaces, not evidence that ordinary `rig up` performs a migration.

## Findings and full-path ledgers

### A1 — Immediate observation failure is mislabeled as timeout

**Consequence: correctness of diagnostics; medium priority.** `withinDeadline` handles both promise rejection and abort by resolving the same fallback (`src/runtime/status.ts:59–73`), whose reason says the observation missed the deadline (`153–158`). A provider that rejects immediately produces false timing evidence. The distinction matters to status/doctor consumers diagnosing permissions/provider failure versus a stuck probe. The existing safe `unknown` state is correct; the reason is not always true.

The coordinating reviewer reproduced this with a read-only call using an immediately
rejecting injected process observer and a 10,000 ms budget. The result immediately
reported `state: "unknown"` with `reason: "Observation did not complete before the
status deadline."` No process was started and no runtime state was read or written.

| Ledger field | Finding-producing evidence |
|---|---|
| Caller job / present call | `projectStatus` needs truthful component observations: `observeTargets(selected, deps.observations)` at `src/runtime/project-status.ts:45`. |
| Proposed call/contract | Keep the domain call, but preserve `unknown` with a safe reason/code distinguishing `observation_failed` and `deadline_exceeded`. Do not expose raw provider errors. |
| Inputs | Recorded targets, supplied observation effects, deadline budget; closure signal for the local helper. |
| Outputs | Materialized reports; callback invocations and cancellation. Immediate rejection currently becomes a timeout claim. |
| Ambient access | The documented shared timer at `status.ts:56`; adapter effects remain supplied capabilities. |
| Prerequisites | Inputs are recorded target plans; provider promises may reject, ignore cancellation, or never settle. |
| Failure owner | Observation layer should choose safe report states, preserving failure versus timeout as safe data. This does not require throwing ordinary observation failures. |
| Direct callees and trust | `effects.process/health/artifact/persistent`: reads outside system through supplied capabilities; stub and integration tests exist, but all implementations are not proven. `withinDeadline`: tested through timeouts, rejection distinction untested in the inspected status tests. `aggregate`: value-only report reduction. Promise/AbortController machinery: standard library contract. |
| Conceptual level / policy | Shared deadline ownership is sensible. The result fallback currently merges two policies; split outcomes inside that owner, without extracting one helper per expression. |
| Verification | Add an immediately rejecting process/artifact provider and assert `unknown` with a failure reason; add a never-settling provider and assert timeout reason, preserved port/route, and cancellation. Existing `tests/runtime-status.test.ts:57` tests a common real-time deadline, not the reason distinction. Run runtime-status, runtime-review-regressions, and runtime-application tests. |

### A2 — Pure resolver's absolute-path prerequisite is not enforced

**Consequence: local reasoning/testability; medium priority at the API boundary.** `resolveTargetPlan` advertises a materialized calculation without filesystem reads (`src/config/resolve.ts:65–69`) and takes `workspacePath: string`/`dataRoot: string` (`src/config/types.ts:74–79`). `resolve` in the installed-entrypoint, environment-file, and SQLite branches consults process cwd when neither argument is absolute. For example, an otherwise valid installed component with `entrypoint: "tool.ts"` and `workspacePath: "work"` gets a different absolute result under a different cwd.

Normal production initialization uses canonical `realpath` results, and daemon roots come from `rigRoot()`'s absolute resolution. Thus **this is an API-admitted counterexample, not an observed production failure**. The persisted state schema nevertheless accepts nonempty relative workspace strings (`src/runtime/state-schema.ts:43–44`), and the TypeScript boundary does not carry the absolute invariant. A future caller or manually restored state can bypass the normal acquisition path.

The coordinating reviewer independently reproduced the counterexample with two read-only Bun processes: identical input (`entrypoint: "cli.ts"`, `workspacePath: "work"`, `dataRoot: "data"`) returned `/Users/clay/Projects/github/b-relay/rig/work/cli.ts` from the repository cwd and `/private/tmp/work/cli.ts` from `/private/tmp`. This verifies the admitted-input issue; it does not show that normal initialization supplies relative paths.

| Ledger field | Finding-producing evidence |
|---|---|
| Caller job / present call | `planTarget` supplies resolved source paths to `deps.documents.resolve({ ...planInput, assignedPorts })` at `src/runtime/targets.ts:159`; `doctor` recomputes a recorded plan at `runtime/doctor.ts:104`. |
| Proposed call/contract | Keep values in the resolver. Establish/validate absolute workspace and data roots before calling it; reject relative input at the public resolver boundary, or explicitly supply a base if relative input is intended. A small validation can precede any branded-path design. |
| Inputs | Config, target identity, workspace/data roots, assigned ports and branch/deployment values. |
| Outputs | Materialized plan or `ConfigError`; no intended caller mutation. |
| Ambient access | Transitive `node:path.resolve` cwd fallback at `resolve.ts:151,236,288,304`. No filesystem operation is needed to create the hidden input. |
| Prerequisites | Absolute roots, validated component dependency graph, complete assigned ports. The latter two are checked; absolute roots are not checked here. |
| Failure | Relative paths currently succeed with environment-dependent output. Reject them explicitly if absolute paths are the contract. |
| Direct callees and trust | `parseProjectConfig`: schema validation, tested in config tests. `resolveComponentProperties` and `resolvePlanComponent`: mutate only local structures but inherit cwd fallback. `resolveHooks/interpolate`: value-only, errors on missing properties. `dependencyOrder`: local arrays/maps; relies on preceding schema cycle/name validation. `join`: lexical; `resolve`: deterministic only with an absolute segment. |
| Conceptual level / policy | Current decomposition into properties, components, and ordering is useful. Give absolute-path acquisition one owner instead of threading filesystem clients into calculations. |
| Verification | Add public resolver cases for relative workspace/data roots, absolute roots plus relative component paths, and absolute component overrides. Assert deterministic output or structured rejection. Existing config tests use absolute `/work`/`/data` fixtures (`tests/config.test.ts:263–268`). Run config, profile-policy, runtime-status/doctor, and migration tests if persisted path validation changes. |

The same conditional issue appears in pure-looking registration comparisons (`src/runtime/projects.ts:46,117–126`). Normal document discovery establishes canonical paths; the function signatures and persisted Project schema still permit more values. Do not silently normalize against whichever cwd happens to host the daemon.

### A3 — Git command injection does not substitute filesystem identity

**Consequence: local reasoning/testability; medium priority.** `inspectProjectGit(path, run)` performs two direct `realpath` calls (`src/git/project.ts:26,37`). A fake Git runner cannot test discovery with an invented repository path: real host filesystem state remains required. `ensureProjectGit` inherits that dependency through discovery (`project.ts:69,96`). This is the exact point where a seemingly fully supplied Git policy subtree touches an additional channel.

| Ledger field | Finding-producing evidence |
|---|---|
| Caller job / present call | `inspectInitialization` discovers the repository and default branch before creating Project files: `inspectProjectGit(path, run)` at `src/adapters/project-documents.ts:90`. Remote-helper main also calls it before constructing the protocol dependencies (`src/git/remote-helper.ts:326`). |
| Proposed call/contract | Either explicitly designate Git discovery as a filesystem+Git adapter, or give it a cohesive discovery dependency containing runner and path canonicalization. Have its callers pass acquired canonical paths where practical; avoid a filesystem client through unrelated runtime layers. |
| Inputs | Requested path and command-runner capability. |
| Outputs | Canonical repo path and production-branch choice; supplied runner invocations; rejection. |
| Ambient access | Filesystem path existence/symlink identity through `realpath`; runner may have declared Git effects. |
| Prerequisites | Both requested path and Git-reported repository root must exist and be canonicalizable. |
| Failure | `GIT_REQUIRED` is structured, but filesystem canonicalization can reject with native filesystem errors. `ensureProjectGit` only handles `GIT_REQUIRED` for authorized creation, so native errors intentionally bypass that recovery but are not described at this boundary. |
| Direct callees and trust | `realpath`: real OS filesystem, unavoidable in current isolated tests. `run`: explicit and replaceable; Git test integration exists. `rigRemoteUrl`: pure validation. `ensureRigRemote`: capability-based Git effects, distinct remote conflict policy and tests. |
| Conceptual level / policy | Repository canonicalization and Git-default-branch discovery are coherent adapter work. The problem is a partially expressed seam, not excessive length. Preserve remote conflict and explicit create-Git policy. |
| Verification | Add fake canonicalization tests for symlinks, unavailable paths, and a fake runner that resolves a nonexistent host path; assert classified failure and no Git initialization after filesystem failure. Existing `tests/git-project.test.ts:23–51` uses real temp directories, which verifies integration but does not prove full dependency substitution. Run git-project, git-preflight, initialization-slug, project-registration, and remote-helper tests. |

### A4 — Deadline ownership is documented; scheduling dependency remains implicit

**Consequence: testability/local reasoning; medium-to-low priority.** Do not remove bounded waits. `observeTargets` documents a common deadline, `monitorRuntimeFailures` documents a bounded pass, and `awaitReady` implements the lifecycle's configured readiness budget. These are legitimate effect owners. But replacing every supplied observer still leaves them dependent on real timers (`status.ts:56`, `activity.ts:20`, `lifecycle.ts:271,284`). Even the injected `now` in the failure monitor is only the activity timestamp; it does not control expiration.

| Function ledger | Caller, inputs and outputs | Ambient/prerequisites/failure | Direct callees and trust; correction and tests |
|---|---|---|---|
| `observeTargets` | Status/doctor/registration call with targets, effects and optional budget; returns reports, invokes probes, aborts them. | Shared global timer; adapter may ignore signal; fallback report on timeout or rejection. | Supplied probes are controlled, timer is not. A1 covers failure distinction. Accept a caller-owned deadline/scheduler capability at the operation owner, keeping report aggregation value-only. Test controlled expiry before/after completion and abort cleanup. |
| `monitorRuntimeFailures` | Composition calls with store, observations, timestamp provider; returns recorded count and persists activity. | Global timeout; caller must serialize against lifecycle changes (documented at `activity.ts:11`). | `store.read/update` and process observation explicit; `observeBeforeDeadline` consumes supplied signal; hashing pure. Acquire deadline alongside the monitor invocation or provide one timing owner. Assert controlled expiry, exactly-once activity, racing state update, and no activity on uncertainty. Existing activity-crashes tests cover most policy branches using wall time. |
| `awaitReady` via `createTargetLifecycle(effects).up` | Lifecycle needs readiness before routes/post-start; component timeout, target, health capability; returns completion or `HEALTH_FAILED`, aborts health. | Two global timers; provider may never settle; rollback depends on rejection from this function. | `effects.health` explicit; Promise race tested through `tests/runtime-lifecycle.test.ts:51`. Supply scheduling at lifecycle construction or a bounded readiness capability with the timeout contract stated. Preserve non-cooperating-provider protection. Assert deterministic retry, success, expiration, abort and rollback. |
| `followLogs` via `runRigCli` | Reads from supplied daemon cursor and writes supplied output until supplied cancellation. | Optional `wait` silently selects the global-timer implementation at `cli/rig.ts:86`. | Client/output/wait replaceable when supplied; cursor rendering value-only. Make wait required in `CliDependencies` and supply the real implementation in `main`, or explicitly name a convenience host wrapper. Existing CLI follow tests should retain cursor and cancellation behavior. |

The underlying shape already works well: time-based policy belongs with a bounded operation, not with a pure report mapper. Prefer one small timing abstraction only where controllable expiry materially helps; do not build a generic effect framework or pass timer mechanisms through layers that do not use them.

## Exactness and readability follow-ups

- **Command/result coupling:** `RigRuntime.command` and `ControlPlaneOptions.handle` return `Promise<unknown>` (`runtime/application.ts:19`, `daemon/server.ts:9`). `RuntimeCommand` is one object with an action enum and many optional fields (`daemon/protocol.ts:4–65`). The runtime therefore repeatedly checks prerequisites and CLI output defensively coerces values with `object`, `rows`, and `word` (`cli/output.ts:125–140`). A discriminated command/result contract would let callers know what each action can return and would eliminate some defensive reconstruction. Keep external JSON validation; unknown is appropriate at a transport intake, less helpful inside the trusted dispatcher. This is a caller-usability improvement, not a finding that every operation currently fails.
- **Capability failure/lifetime documentation:** `Supervisor`, `TargetEffects`, `ProjectDocuments`, and `RuntimeFiles` name useful domain operations but omit several promises their implementations rely on: observation cancellation, partial progress, rollback lifetime, and port reservation release. For example `reservePorts` closes its probe socket before return (`adapters/runtime-files.ts:42–43`); the adapter comment acknowledges startup races, but the shared interface at `runtime/contracts.ts:62` does not say the returned numbers are suggestions, not live reservations. Document this at the interface or choose a name that preserves that distinction.
- **Narrow gratuitously broad arguments:** `persistTarget(target, deps)` uses only `deps.store` (`runtime/targets.ts:175–184`), while callers already possess the store. `activateDeployment`'s positional `noUp` (`runtime/deploy.ts:10`) and `selectProject`'s `readConfig` (`runtime/projects.ts:11`) hide policy at calls. A focused dependency `Pick` and named request options would improve call-site reading without adding new architecture.
- **Preserve meaningful recovery detail:** `activateDeployment` has explicit stages and handles partial publication, but some derived errors discard original causes (`runtime/deploy.ts:55–61,76–82,93–98`). Keep user-facing messages safe while retaining structured causal evidence for diagnostics. The state/rollback distinctions themselves are valuable and should survive simplification.
- **Readability before file splitting:** `createRuntime`'s long dispatcher has real branching complexity, and `createTargetEffects` coordinates real ownership transactions. Extract a domain operation when it removes policy from the dispatcher or creates a useful test boundary. A file-size threshold alone is not evidence for dozens of wrapper functions.

## What is already well designed

- `diagnosticRecord(entry, source, timestamp)` makes time explicit and restricts output to a closed metadata policy (`diagnostics/file-log.ts:33`). Its filesystem adapter acquires time and returns write failure as data.
- `targetName`, `recordedPorts`, Git commit validation, terminal sanitization, remote URL validation, and structured schema validation form useful small value-oriented subtrees.
- `runRemoteHelper` and `runRigdCli` accept operational capabilities instead of importing concrete process/network mechanisms into their protocol/command logic.
- Deployment recovery distinguishes pending, committing, and blocked states; checkpoints carry target identity. This is a substantive partial-progress contract, not expendable bulk.
- Lifecycle stop distinguishes stopped processes with failed hooks from failure to stop processes. `stopForTransition` deliberately interprets only `STOP_HOOKS` as safe continuation (`runtime/lifecycle.ts:299`), keeping the failure policy near the transition.
- Config edits operate on explicit private documents, reject destructive comment loss, preserve revision conflicts, and place publication in the filesystem adapter.
- Migration conversion and source evidence processing do not substitute today's configuration for missing historical deployment facts. The active adoption guard prevents ordinary runtime mutations before compatibility ownership is settled.

## Coverage index

**Traced** means entrypoint/caller, consequential body, direct effect boundary, and selected governing tests were inspected. **Scanned** means exports/imports/ambient signals or selected bodies were inspected; it is not a full function ledger. **Types** means contracts/schema/barrel inventory, not an executable function verdict. Grouped filenames are each accounted for; `.test.ts` modules are test evidence, excluded from the 79-module production count.

| Directory | Modules | Depth and result |
|---|---|---|
| `src/` | `index.ts`, `rigd.ts` | Traced; O composition/process roots. |
| `src/cli/` | `rig.ts`, `rigd.ts` | Traced; C command orchestration; optional wait D in rig. |
| | `commands.ts`, `interaction.ts`, `failure.ts`, `output.ts` | Traced main boundary/selected helper bodies; C callbacks, H value helpers; Commander internals ?. |
| | `entry-environment.ts`, `terminal-text.ts` | Traced; O host acquisition, H text conversion. |
| | `types.ts` | Types; explicit output/client capabilities, optional wait and unknown responses. |
| `src/daemon/` | `composition.ts`, `server.ts`, `client.ts`, `config-editor.ts` | Traced; O roots/transport, C editor, H validation. |
| | `host.ts`, `admin.ts`, `files.ts`, `offline-doctor.ts` | Boundary and selected-body review; O lease/admin/files/diagnostics, full lifecycle race proof ?. |
| | `protocol.ts` | Types/schema inspected; broad optional action contract. |
| `src/runtime/` | `application.ts`, `lifecycle.ts`, `status.ts`, `activity.ts` | Traced; explicit orchestration plus interior timing owners and A1 failure defect. |
| | `targets.ts`, `deploy.ts`, `projects.ts`, `registration.ts` | Traced; C operation dependencies, H identity/port helpers; inherited timing/path caveats. |
| | `project-status.ts`, `doctor.ts`, `stop.ts`, `ports.ts` | Traced; C observations/transitions, H report/value helpers, inherited A1/A4. |
| | `state-store.ts` | Traced; O filesystem and explicit mutable update callback; one-writer prerequisite documented. |
| | `contracts.ts`, `state-schema.ts` | Types/schema inspected; path and capability-documentation gaps. |
| `src/config/` | `resolve.ts`, `documents.ts`, `editor.ts` | Traced resolver/editor and selected document boundaries; D conditional cwd, O publication, H structured edits. Full filesystem race proof ?. |
| | `schema.ts`, `types.ts`, `errors.ts`, `index.ts` | Schema/types/barrel inspected; selected H validation functions; not every Zod branch audited. |
| `src/git/` | `project.ts`, `preflight.ts`, `remotes.ts`, `remote-helper.ts` | Traced; D filesystem discovery seam, C injected Git/protocol operations, H parsers and validation. |
| `src/adapters/` | `project-documents.ts`, `deployment-sources.ts`, `runtime-files.ts`, `host-inspection.ts`, `terminal-interaction.ts` | Traced main boundaries; O document/host/port adapters, C source adapter, supplied streams own terminal channel. |
| | `target-effects.ts` | Traced factory, health, environment, output, ownership entrypoints; O deliberately. Remaining installation/preparation detail scanned ?. |
| | `target-log-reader.ts` | Traced main read/cursor path, selected helper bodies; O files, H parsing/order; full log-tail algorithm proof ?. |
| | `artifact-ownership.ts`, `effect-transactions.ts`, `admin-activity.ts` | Scanned selected boundaries; O files/transactions/activity with explicit ownership/clock. No blanket correctness verdict. |
| `src/providers/` | `command-runner.ts`, `launchd-supervisor.ts`, `process-identity.ts` | Traced main boundaries; O OS owners, C supplied runner where present; full subprocess event-race proof ?. |
| | `artifact-installer.ts`, `git-source-store.ts`, `caddy-router.ts` | Traced selected file/command/rollback boundaries; O owners with H transformations. |
| | `child-supervisor.ts` | Selected-body review of leases, stop, restart and capture; O with mixed injected/ambient timing. Full recovery/capture concurrency proof ?. |
| | `capture-status.ts`, `captured-process.ts` | Scanned; O filesystem/clock/process framework owners. |
| | `contracts.ts` | Types; useful provider operations, incomplete failure/lifetime documentation. |
| `src/diagnostics/` | `file-log.ts`, `host-log.ts`, `types.ts` | Traced metadata/record/lazy config and selected lock bodies; O files, H metadata, explicit write failure. Remaining rotation internals scanned ?. |
| `src/domain/` | `errors.ts`, `git.ts`, `runtime.ts` | Value/error and contract review; H commit/error helpers, explicit StateStore mutation. |
| `src/migration/` | `adoption.ts` | Traced active guard and selected manifest boundaries; O files, H validation; finalization concurrency detail scanned ?. |
| | `files.ts`, `convert.ts`, `source-evidence.ts` | Traced preview/conversion/source boundaries; O current evidence and migration publication, H validated conversion/recovery. Full cutover fault matrix ?. |
| | `schema.ts`, `types.ts`, `index.ts` | Types/schema/barrel scanned; absolute legacy-path validation matters to conversion honesty. |

Existing tests inspected as evidence include runtime-status, runtime-lifecycle, runtime-review-regressions, activity-crashes, config, and git-project. Additional test files were inventoried by boundary. No test count or passing claim is made for this review. Implementers should use isolated `RIG_ROOT` fixtures and run the focused sets named above, then the repository's broader checks if shared contracts change.
