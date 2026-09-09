# Issue 88: Project discovery owns filesystem identity

Original base: `96ce1a0aad64b47a0e6e929b44a66f578b1dffe6`. Rebased locally onto
merged issue 87 at `bb0e7fbaf733038d42c3892afaedccdb51741db6`. Only the
append-only plan documentation conflicted; both additions were preserved. Issue
88 adds no resolver changes beyond the merged base.

## Interface choice

Before: `inspectProjectGit(path, run)` implied a controllable Git operation but
called ambient `realpath` twice. Initialization separately canonicalized a
non-repository and queried `init.defaultBranch` after catching `GIT_REQUIRED`.

Compared two shapes before implementation:

1. A cohesive discovery dependency (`canonicalize`, `run`) owned by the Git
   discovery module, acquired once at the adapter/entrypoint. Read-only location
   inspection reports canonical repository/directory identity and branch policy;
   strict Git inspection rejects the directory-only outcome.
2. Pre-acquire a canonical identity and Git facts at each caller, then pass those
   values to pure policy. This makes policy small but makes initialization and
   the remote helper repeat canonicalization, missing-repository classification,
   and branch acquisition ordering. It also leaves setup needing reacquisition.

Selected shape 1, the smallest coherent owner for these callers. The dependency
is local to discovery/setup; no filesystem framework crosses runtime planning.
`createProjectDiscovery` owns native realpath and captures the process environment,
forcing Git diagnostics to the C locale. Tests supply both operations without
opening real paths. The returned `repoPath` remains an absolute canonical string;
plan resolution retains its existing contract.

## Effects and failures

`inspectProjectLocation` reads filesystem identity, repository metadata, cached
origin HEAD, current symbolic HEAD, or Git initial-branch config. It never fetches,
initializes Git, or edits a remote. Missing path (`GIT_PATH_MISSING`), unreadable
path (`GIT_PATH_UNREADABLE`), bare repo (`GIT_BARE`), command/malformed-output
failure (`GIT_DISCOVERY`) and strict non-repository (`GIT_REQUIRED`) are distinct.
External error text is never included in these errors. Ordinary non-repository
classification requires Git's C-locale diagnostic and exit 128; uncertainty fails
closed instead of authorizing initialization.

`ensureProjectGit` owns explicit `git init` after identity validation and confirmed
non-repository discovery, then delegates only missing conventional remote addition
to `ensureRigRemote`. Existing fetch/push conflicts remain `GIT_REMOTE_CONFLICT`.
Initialization owns config writes and `PROJECT_IDENTITY` checks, preserving their
ordering before setup. A successful Git init followed by failed discovery/remote
setup may leave the initialized repository; there is no destructive compensation.
The remote helper performs strict read-only discovery before its existing daemon
transport operation. Neither caller contains canonicalization policy now.

## Function contract ledger

| Functions | Inputs/results | Effects, mutation, failure, ownership and direct-callee trust |
| --- | --- | --- |
| `createProjectDiscovery` | Supplied runner -> discovery dependency | OS acquisition owner: captures environment and native realpath. Runner owns process execution; adapter pins locale, retains user Git config/PATH. Native realpath and runner validated through real repository tests. |
| `canonicalPath` | Path + discovery -> canonical absolute path | Calls supplied filesystem operation only; no argument mutation. Maps missing/unreadable errors and rejects malformed canonical output. Dependency must resolve symlinks; real adapter and fake tested. |
| `readGit` | Directory, argument list, discovery -> command result | Calls supplied runner, with bounded timeout inherited from runCommand. Maps thrown command failures to safe discovery error. No caller state mutation. |
| `branchValue`, `discoveryFailure` | Output text -> branch, or no inputs -> safe tagged error | Pure validation/error construction. No ambient effects, borrowed retention, partial progress or mutation. Empty/control/whitespace branch output rejected. |
| `inspectProjectLocation` | Path + discovery -> ProjectGit + gitRequired | Owns acquisition ordering and branch fallback policy, only local read commands. Canonicalization, readGit and branch validation trusted through fake and real tests. Complete materialized result, no retained caller state. |
| `inspectProjectGit` | Path + discovery -> ProjectGit | Strict repository policy over location inspection; rejects directory-only outcome. Same read effects, no mutation. |
| `ensureProjectGit` | Setup request + discovery -> Git identity and setup effects | Validates name before setup, conditionally initializes canonical directory, reinspects, delegates remote policy. `rigRemoteUrl`/`ensureRigRemote` existing tested owners; preserves conflict and partial-progress behavior. |
| `inspectInitialization` | Path, command, discovery -> config/name/branch identity | Discovery owns filesystem/Git identity; existing `readProjectConfig` owns config I/O. Config-missing is expected, other config errors propagate. Config identity conflict prevents setup. Pure projectSlug unchanged. |
| `createProjectDocuments` initialization closures | Root/runner and operation inputs -> initialization information/config | Adapter acquires discovery once. Initialization config I/O and Git setup remain distinct effects. Registration integration proves existing name/path checks and retry behavior. |
| Remote helper `main` | CLI args + ambient entry environment -> exit code | Existing effect owner constructs discovery with command runner and cwd. Uses acquired canonical repoPath; daemon and output behavior unchanged, verified by actual Git push integration. |

Inherited debt: config-document discovery is a separate existing config search
operation and still owns its filesystem reads. Rename/config IO and remote command
failure policy are unchanged. This ticket does not redesign those interfaces.
Canonical identity is an observation, not a filesystem lock; concurrent repository
replacement is not made atomic here.

## Evidence

- Red: new fake-only discovery test failed with `ENOENT ... /fictional/link/nested`
  before implementation, proving a fake runner could not control discovery.
- Green: `RIG_ROOT=/tmp/rig-88-final.rig bun test tests/project-discovery.test.ts
  tests/git-project.test.ts tests/initialization-slug.test.ts
  tests/git-remote-helper.test.ts`: **15 pass, 82 assertions**.
- Focused integration with authorized process/loopback execution:
  `RIG_ROOT=/tmp/rig-88-integration.rig bun test tests/git-push.test.ts
  tests/project-registration.test.ts`: **6 pass, 35 assertions**.
- `bunx tsc --noEmit`: passed after `bun install --frozen-lockfile` restored
  missing worktree dependencies (no lockfile change).
- Temporary real repositories cover nested paths, symlinks, unborn/current,
  cached origin default and detached fallback, bare rejection, idempotence,
  conflicting remote preservation, and exact init plus missing-remote mutations.
- Controlled cases cover fictitious canonical paths, missing/unreadable paths,
  non-repository, malformed roots/branches, command failure and uncertain setup.
- Full suite, compiled entrypoint gates and independent reviews belong to the
  supervising agent. No live runtime state, real remotes or deployment modified.

### Rebased validation

After integrating merged #87 locally, strict typecheck passed. Focused discovery,
Git, config, initialization-slug and remote-helper tests passed: **38 tests, 157
assertions**, with `RIG_ROOT=/tmp/rig-88-rebase.rig`. Authorized isolated real push
and registration integration passed again: **6 tests, 35 assertions**, with
`RIG_ROOT=/tmp/rig-88-rebase-integration.rig`. No production code or test changes
were required by the rebase. Publication remains pending explicit approval.
