# Issue Drafts: CLI And Provider Cleanup

> Parent PRD: #54
> Source plan: `plans/cli-provider-cleanup.md`
> Status: complete - GitHub issues #55 through #62 are closed.

## 1. Clean normal Rig CLI surface (#55)

Type: AFK
Blocked by: None - can start immediately

### What to build

Remove obsolete and internal surfaces from the normal `rig` CLI so help,
parsing, and public command behavior match the accepted Target/Branch/Commit
model.

### Acceptance criteria

- [x] `rig bump` is removed from normal CLI behavior and help.
- [x] Normal `rig` help does not expose `--state-root`, generic `--config`,
  provider-profile flags, package-script flags, broad `--json` flags, or stub
  provider choices.
- [x] Removed or hidden surfaces have public-behavior tests.
- [x] Remaining help text uses Project, Target, Branch, Commit, Stable Target,
  Preview, and Working copy language.

## 2. Split daemon administration into `rigd` (#56)

Type: AFK
Blocked by: None - can start immediately

### What to build

Make `rigd install`, `rigd status`, and `rigd uninstall` the daemon
administration surface, while keeping normal `rig` commands as clients of an
installed daemon.

### Acceptance criteria

- [x] `rigd install` sets up daemon state and creates the local control-plane
  auth token.
- [x] `rigd status` reports daemon installation, running, and reachability
  state without becoming a project inventory command.
- [x] `rigd uninstall` removes daemon admin artifacts but refuses while
  Rig-managed Targets are running.
- [x] Normal `rig` commands do not install or manually start `rigd`; they fail
  with guidance when `rigd` is missing or unreachable.

## 3. Rework `rig init` around Project identity and daemon registration (#57)

Type: AFK
Blocked by: #56

### What to build

Make `rig init` create committed Project config, configure the Rig remote when
safe, and register the Project with `rigd` using a Host-unique Project
identity.

### Acceptance criteria

- [x] `rig init` resolves the Git repository root from any subdirectory and
  writes Project config at the root.
- [x] Interactive init confirms Project identity and Production branch;
  non-interactive init uses detected/default values unless explicit options are
  provided.
- [x] `rig init` configures the `rig` Git remote when absent, continues when it
  already points to the expected Rig remote, and refuses to overwrite a
  different remote.
- [x] Full init success requires registration with `rigd`.
- [x] Partial config-written registration failure is reported clearly and can be
  completed by rerunning `rig init`.
- [x] Duplicate Project identity/path conflicts are rejected.

## 4. Align `list`, `status`, and `doctor` scopes (#58)

Type: AFK
Blocked by: #56 and #57

### What to build

Implement the accepted inventory and diagnostic scopes: Host project summaries
for `list`, Project-wide target status for `status`, and Host-plus-Project
diagnostics for `doctor`.

### Acceptance criteria

- [x] `rig list` reads daemon-backed Host inventory and shows Project summaries
  with Target counts.
- [x] `rig list` fails when `rigd` is unreachable instead of reading stale
  files.
- [x] `rig status` is Project-scoped and shows all Targets for one selected
  Project.
- [x] `rig status` fails outside a Project unless `--project <name>` resolves to
  a Project known to `rigd`.
- [x] `rig doctor` runs Host diagnostics even outside a Project, adds Project
  diagnostics when context exists, and remains read-only by default.
- [x] `rig doctor` reports Project identity drift, duplicate identity/path
  conflicts, missing Host capabilities, and daemon reachability findings.

## 5. Implement Branch/Commit deploy for Stable Targets and Previews (#59)

Type: AFK
Blocked by: #55, #57, and #58

### What to build

Replace ref/lane deploy behavior with the accepted `rig deploy live` and
`rig deploy preview` command model.

### Acceptance criteria

- [x] `rig deploy live` deploys the configured local Production branch.
- [x] `rig deploy live <branch>` only accepts the configured Production branch.
- [x] `rig deploy preview` deploys the current Branch and fails from detached
  HEAD.
- [x] `rig deploy preview <branch>` deploys an explicit local Branch.
- [x] Preview deploys from the Production branch itself are rejected with
  guidance to create a Preview branch such as `preview/main`.
- [x] Same-Commit deploys are no-ops unless `--force` is used and do not start a
  stopped Target.
- [x] `--no-up` materializes without starting; replacing a running Target with
  `--no-up` stops the old process rather than leaving stale code running.
- [x] CLI deploy warns for ahead/behind local upstream state without fetching.

## 6. Implement Rig remote deploy classification (#60)

Type: AFK
Blocked by: #59

### What to build

Make Git push deployment classify pushed destination Branches into Stable Target
or Preview deploys using the same Branch/Commit rules as CLI deploy.

### Acceptance criteria

- [x] Pushing the Production branch to the Rig remote updates the Stable Target
  and brings it up by default.
- [x] Pushing any non-Production destination Branch updates a Preview and brings
  it up by default.
- [x] `git push rig main:preview/main` classifies by destination Branch and
  deploys a Preview.
- [x] Same-Commit pushes are no-ops and do not start stopped Targets.
- [x] Rig remote pushes do not run local upstream/ahead/behind preflight checks.
- [x] Rig remote pushes do not support `--no-up` in the first release.

## 7. Implement Target lifecycle and logs (#61)

Type: AFK
Blocked by: #58 and #59

### What to build

Make `up`, `down`, `restart`, and `logs` use one Target selection model and act
only on existing Targets.

### Acceptance criteria

- [x] `rig up`, `rig down`, `rig restart`, and `rig logs` share Target selection:
  interactive picker in TTY, fail with guidance in non-interactive use.
- [x] Bare Target names select Working copy or Stable Targets; Previews require
  `preview <branch>`.
- [x] Missing Preview lifecycle commands fail with guidance to deploy first.
- [x] `down` stops a Target without removing it from inventory.
- [x] `restart` may start an existing stopped Target but does not redeploy or
  change Commit.
- [x] `logs` prints recent combined stdout/stderr and exits by default.
- [x] `logs --follow` streams.
- [x] `logs` can read stopped Target logs when logs exist.

## 8. Refactor providers behind resolved Runtime context (#62)

Type: AFK
Blocked by: None - can start when write scopes are kept disjoint

### What to build

Move provider adapters away from global path/config helpers and toward resolved
Runtime context plus typed provider-specific config supplied by `rigd`.

### Acceptance criteria

- [x] `rigd` resolves Project config and Host config into a runtime plan before
  calling providers.
- [x] Provider calls receive shared Runtime context plus typed
  provider-specific config.
- [x] Caddy-specific paths and route config are passed only to the Caddy provider.
- [x] Providers do not read home config, Project config, or global path helpers
  directly.
- [x] Tests prove providers can run against injected context.
- [x] First-party provider contracts leave room for future third-party providers
  using the same shape.
