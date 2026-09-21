# Rig Context

This is the domain model and product contract for Rig. For the architecture see
[DESIGN.md](DESIGN.md), for the code layout the
[module map](README.md#module-map), and for command behavior the
[guide](docs/rig-guide.md).

## Terms

### Rig

The local Mac deployment system as a whole. Rig is repo-first,
lifecycle-first, and provider-backed.

### rig

The normal user CLI for project lifecycle, deploy, status, diagnostics, and
safe project management actions.

### rigd

The Rig runtime authority daemon. `rigd` is the only module that should mutate
runtime state for lifecycle and deploy actions: deployment inventory,
Preview materialization, port selections and inventory exclusions, runtime events,
receipts, health state, and process execution all sit behind `rigd`.

_Relationship_: A future Rig web UI should be a client of `rigd` through a
control-plane API, not logic deeply embedded in daemon internals.

_Relationship_: The control plane is HTTP on `127.0.0.1` only, authenticated with a
Bearer token stored at `<RIG_ROOT>/auth/control-plane.token`. The port is
recorded in `<RIG_ROOT>/daemon/address.json`.

_Relationship_: The local control-plane auth token belongs in Host/user Rig
state, not committed Project config, because it is a machine credential for
talking to local `rigd`.

### rigd CLI

The daemon administration CLI for installing, uninstalling, and checking the
status of `rigd`; it should not expose broad manual daemon control.

_Relationship_: User-facing inventory commands such as Project listing belong
to `rig`, even when `rig` queries `rigd` for the data. The `rigd` CLI should
remain limited to daemon administration.

_Relationship_: `rigd install` creates the local control-plane auth token as
part of daemon setup.

_Relationship_: `rigd uninstall` removes daemon administration artifacts such as
the local control-plane auth token. It never deletes Project Persistent storage
or other Project state.

_Relationship_: `rigd uninstall` refuses with `TARGETS_RUNNING` when Rig-managed
Targets are running and guides the user to stop them first, so uninstall does
not leave unmanaged processes or routes behind.

_Relationship_: Unresolved Target recovery also blocks uninstall, even when
the candidate is stopped. Keep daemon control available so explicit `rig down`
can finish recovery before uninstall is retried.

_Relationship_: There is no `rigd uninstall --force`. Bulk stop/delete cleanup semantics require separate design.

_Relationship_: `rigd status` reports installed, running, reachable, the serving
daemon's version and warnings; it exits 1 when `rigd` is not reachable.
Project and Target status belongs to `rig list` and `rig status`.

### User response

The human-readable command result printed directly by `rig` or `rigd`.
_Avoid_: log, info event

_Relationship_: User responses should be concise, formatted for people, and
should not expose internal log levels, tagged error types, or structured
diagnostic details by default.

_Relationship_: Error User responses should be compact and actionable. They
should avoid `[ERROR]`, tagged error names, raw JSON, and internal details in
normal mode, while optionally pointing to a Diagnostic log path for deeper
debugging.

_Relationship_: Expected usage errors should be self-contained and should not
point to Diagnostic logs. Unexpected failures, provider failures, and corrupt
state may point to the relevant Diagnostic log when deeper evidence is useful.

_Relationship_: Successful User responses should be terse by default. They
should report the outcome the user asked for and omit Host internals such as
state roots, namespaces, provider details, and launchd labels unless a
diagnostic command or future verbose mode explicitly asks for them.

_Relationship_: User responses should be plain text first. Rig should rely on
spacing, headings, indentation, and short labels before adding terminal color
or icons. Color can be added later at the user-output adapter when stdout is a
TTY.

_Relationship_: Long-running commands may show a small number of meaningful
progress phases before the final result. Fast commands should print only their
final response.

### Diagnostic log

Structured operational evidence produced by `rig` or `rigd` for debugging Rig
itself.
_Avoid_: user response, Target logs

_Relationship_: Diagnostic logs are distinct from User responses. They may
include levels, tagged errors, structured context, and internal events that are
too noisy for normal command output.

_Relationship_: Diagnostic logging should be enabled by default and written to
Host Rig state. Normal command output should stay quiet, but error User
responses may point to the relevant Diagnostic log path.

_Relationship_: `rig` and `rigd` should have separate Diagnostic logs because
the CLI and daemon have different lifecycles and failure modes.

_Relationship_: Healthy User responses should not show Diagnostic log paths by
default. Error or failure User responses may show the relevant Diagnostic log
path as a follow-up detail.

_Relationship_: Diagnostic logs must not expose auth tokens, environment
values, or complete configs by default. They should record safe structured
metadata and refer to Target logs rather than copying Target output wholesale.

### Activity log

A user-facing history of meaningful Rig actions across Projects and Targets.
_Avoid_: audit trail, Diagnostic log, Target logs

_Relationship_: The Activity log answers what Rig did, such as deploys,
lifecycle actions, crashes, daemon installation, and Project registration. It
is distinct from Diagnostic logs, which explain internal execution details, and
Target logs, which contain managed runtime output.

_Relationship_: Rig should avoid calling this an audit trail until retention,
identity, immutability, and tamper-evidence guarantees are explicitly designed.

_Relationship_: `rig activity` presents Activity history through the same
user-output model as other commands rather than a one-off formatter.

_Relationship_: The Activity log should include Operations that reached
`rigd`, including successful, failed, and unchanged outcomes. Usage mistakes
that never attempted an Operation should not appear.

### Operation

A lifecycle, deploy, registration, or daemon action that Rig attempts and
tracks to a final outcome.

_Relationship_: An Operation has a final outcome such as started, stopped,
deployed, failed, or unchanged. `accepted` is transport language and should not
be used as the user-facing outcome.

_Relationship_: One Operation should be traceable across the `rig` and `rigd`
Diagnostic logs. Its identifier should stay hidden on ordinary success and may
be shown when an unexpected failure requires investigation.

### Host

A computer that can run `rigd` and own Rig runtime state.

### Host config

The user-authored configuration for one Host, stored at
`<RIG_ROOT>/config.yaml` (`~/.rig/config.yaml` by default). Host config is YAML only
([ADR 0001](docs/adr/0001-yaml-only-project-config-cutover.md)).

_Relationship_: Runtime records and Diagnostic logs are machine-owned state,
not Host config, and may remain JSON or JSONL.

### Project deletion

The destructive removal of a Rig project and some or all associated state;
this requires a dedicated design before implementation.
_Avoid_: archive, unrig

_Relationship_: `rig forget` is not Project deletion. It removes a stopped
Project's registration and leaves the repository, data, and Activity history
in place. Previews must be destroyed first.

### Expert surface

There is no expert surface. `RIG_ROOT` is the only isolation switch; there are
no `--state-root`, `--config`, `--log-level`, package-script, or provider
flags.

_Relationship_: Diagnostic-log verbosity is `diagnostics.level` in Host config.

_Relationship_: Normal commands discover Project config from the workspace or
`--project`, and Host config from `RIG_ROOT`.

### Deploy classification

The Production branch maps to the Stable Target, and any other Branch maps to a
Preview; a mismatch is refused as `BRANCH_POLICY`. Classification does not
materialize Deployments, enforce the Preview limit, write inventory, select
ports, or start processes.

### Target

The user-facing runtime object a Rig command acts on, such as the Working copy
Target, the Stable Target, or a Preview.
_Avoid_: lane when speaking about the user-facing CLI

### Component

A named Project capability within a Target: a Service (managed) or a Tool
(installed). A database is an ordinary Service.

_Relationship_: Services are healthy, unhealthy, running, starting, stopped, or
failed. Tools are installed or missing. Either may be `configured` (not yet
recorded) or `unknown`.

_Relationship_: `healthy` means a configured health check passed. A managed
component without a configured health check may be `running`, but should not be
reported as `healthy` without evidence.

_Relationship_: A Target may be running while its components have different
states. `rig status` should show the Target state first and component states
underneath it.

_Relationship_: Component state shown by `rig status` should come from fresh,
read-only observations when possible rather than desired state alone. A check
that cannot complete promptly should produce `unknown` instead of delaying the
entire Project status response.

_Relationship_: A Target is `healthy` only when every Service is healthy;
otherwise, with every Service up, it is `running`, or `unhealthy` when one
fails its health check. Every Component counts: a missing Tool beside healthy
Services makes the Target `degraded`, as does any partial runtime capability.
`failed` is reserved for a Target with no usable Service. A Target whose
Services are all stopped is `stopped`.

_Relationship_: A Target containing only Tools is `ready` when they are
installed.

_Relationship_: Configured routes should remain visible in `rig status` when a
Target is stopped. The Target and component states communicate that the route
is not currently available.

### Service

A named Project process managed within a Target, such as an API, worker, or
database server. Its application accepts ordinary inputs and can run independently
of Rig.
_Avoid_: Tool, Deployment

### Tool

A named executable a Project makes available for invocation, rather than a
Service kept running by Rig. A Project can contain Tools, Services, or both.
_Avoid_: Service, background process

### Recipe

A versioned, bundled template that prints an ordinary Service block for the user
to paste into Project config and then own. A comment above the Service records
which recipe version it came from.
_Avoid_: plugin, provider, managed database

_Relationship_: A generated Service is config like any other. Planning and
running a Target never read the recipe comment or the recipe catalog; only
`rig recipe diff` and doctor's notices do.

_Relationship_: Rig never regenerates or rewrites a generated Service. A newer
recipe version is an informational notice, never a failing check.

### Target role

The role of a Target: Working copy, Stable, or Preview. Project config keys
Targets by role (`working`, `stable`, `preview`). A Target's role is distinct
from its configured or generated name.
_Avoid_: Target name, Target class

### Working copy Target

The Target backed by the current Working copy, with a configurable alias that
defaults to `local`.

_Relationship_: The Working copy Target name and the Stable Target name must
differ.

_Relationship_: The Working copy Target name belongs in committed Project
config as the default Project policy.

### Project

A repo or app managed by Rig.
_Avoid_: product name

_Relationship_: Project identity used for routing should be chosen during
`rig init`. Interactive init defaults to a slug from the repository root
directory name and lets the user accept or change it. Non-interactive init
uses the default unless one is explicitly provided.

_Relationship_: Project identity must be unique per Host because it
participates in routing and explicit `--project <name>` selection. `rigd`
rejects registering a different Project with the same identity, while
allowing idempotent initialization of the same Project.

_Relationship_: `--project <name>` selects the configured Project identity
known to `rigd`, not the filesystem folder name. The folder name is only the
default suggestion during initialization.

_Relationship_: Project identity belongs in committed Project config because
it affects routing, explicit Project selection, and Host-level uniqueness.

_Relationship_: Project identity is managed config. `rig init` creates it, and
`rig rename` changes it for a stopped Project, coordinating Project config and
`rigd` inventory. A hand edit of the name is adopted with `rig rename` too.

_Relationship_: `rig list` is a Host-level Project inventory command. It
lists Projects with summary metadata such as Target count, but it does not show
every Target for every Project.

_Relationship_: `rig list` reads runtime inventory from `rigd` and fails when
`rigd` is unreachable, rather than falling back to potentially stale local
files.

_Relationship_: The `rig list` response shows each Project's identity, Target
count, and registered repository path, and marks a missing directory. It does
not repeat a healthy daemon summary.

_Relationship_: Project-scoped commands such as `rig status`, `rig up`, `rig
down`, `rig restart`, `rig deploy`, and `rig logs` require a Project context.
They resolve Project context from the current workspace or from an explicit
`--project <name>` that matches a Project known to `rigd`; otherwise they fail
with guidance to run inside a Project or use `rig list`.

_Relationship_: Normal `rig` commands never install `rigd`. If `rigd` is missing,
they fail with `DAEMON_MISSING` and guidance to run `rigd install`.

_Relationship_: Normal `rig` commands never start `rigd` when it is installed but
unreachable. Daemon lifecycle belongs to `rigd install` and launchd; normal
commands fail with `DAEMON_UNREACHABLE` and suggest `rigd status`.

_Relationship_: `rig doctor` is both Host-aware and Project-aware. It always runs
Host diagnostics, and when a Project context is available it also runs
diagnostics for that Project. No flag chooses between Host and Project checks.

_Relationship_: `rig doctor` succeeds outside a Project workspace with Host-only
diagnostics and a clear note that Project checks were skipped.

_Relationship_: `rig doctor --project <name>` runs Host diagnostics plus
diagnostics for the named Project when it is known to `rigd`.

_Relationship_: `rig doctor` still runs the diagnostics that do not require
`rigd` when the daemon is unreachable, and reports daemon reachability as a
finding.

_Relationship_: `rig doctor` is read-only. Any repair behavior must be explicit
and designed separately.

_Relationship_: `rig doctor --project <name>` reports when committed Project
config identity differs from the identity registered in `rigd`. Without
`--project`, a hand-edited name fails Project selection with
`PROJECT_IDENTITY`.

_Relationship_: If repair behavior is added later, `rig doctor --fix` is the
preferred user-facing shape, but its exact automation and confirmation behavior
must be decided as part of the future repair design.

_Relationship_: `rig doctor` runs no Git fetch and inspects no refs. It only
compares the recorded Stable Branch with the Production branch.

_Relationship_: A healthy `rig doctor` response summarizes Host health and,
when present, Project health, followed by a quiet confirmation that no
problems were found. Detailed checks, suggestions, and Diagnostic log paths
are expanded only for problems.

### Project initialization

Registering a Project with Rig and writing the project configuration needed for
Rig commands to resolve Project policy.

_Relationship_: `rig init` configures the Rig remote when possible
because `git push rig <Branch>` is a core deploy path.

_Relationship_: `rig init` runs in `rigd`; without a reachable `rigd` it fails
before writing anything. It does not claim success unless registration
succeeds.

_Relationship_: If `rig init` writes Project config but registration with
`rigd` fails, it does not roll back the file. It reports the partial
initialization clearly, and `rig doctor` can diagnose the mismatch.

_Relationship_: Rerunning `rig init` after partial initialization is
idempotent. If Project config already exists and matches the workspace, `rig
init` continues registration with `rigd` rather than starting over.

_Relationship_: `rig init` fails if existing Project config has a Project
identity already registered in `rigd` to a different Project path. In that
directory `rig doctor` fails with `PROJECT_PATH_CONFLICT` and names
`rig repoint`.

_Relationship_: Moving a Project directory requires an explicit `rig repoint`.
Rig does not automatically update registered Project paths just because it
sees the same Project config at a new location.

_Relationship_: Copying a Project repository to a second folder may become a
new Rig Project on the same Host if the user chooses a new Project identity and
the resulting routes do not collide.

_Relationship_: `rig init` must not overwrite an existing Git remote named
`rig` that points somewhere else. It stops with guidance instead.

_Relationship_: If a Git remote named `rig` already points to the expected Rig
remote URL, `rig init` treats it as already configured and continues.

_Relationship_: `rig init` may run from any subdirectory inside a Git
repository, but it writes Project config at the repository root and tells
the user where it wrote it.

_Relationship_: If `rig init` runs outside a Git repository in an interactive
TTY, it may warn that Rig needs Git and ask whether to create a new Git
repository before continuing. Non-interactive initialization should fail unless
the user explicitly chooses a Git creation path.

_Relationship_: When the user confirms Git repository creation during
interactive `rig init`, Rig may run `git init` and then continue initialization.

_Relationship_: `rig init` never creates Git commits. Deploy commands fail
clearly until the relevant Branch resolves to a Commit.

_Relationship_: `rig init` picks the Production branch from, in order,
`--production-branch`, the branch `origin/HEAD` names, the Host
`deploy.productionBranch` default, then `main`. The checked-out branch is never
assumed to be Production.

_Relationship_: Interactive `rig init` shows that default, names a differing
checkout branch, and lets the user accept or change it. Non-interactive
initialization uses the default unless `--production-branch` is given.

### Config editing

Reading or changing Rig configuration through Rig commands.

_Relationship_: YAML config accepts one ordinary YAML 1.2 document and
comments. Rig rejects duplicate keys, custom tags, anchors, aliases,
merge keys, and multiple documents so configuration remains deterministic.

_Relationship_: The `rigd` control plane has a structured config editor at
`/v1/config` with read, preview, and apply. It checks the document revision,
keeps a `rig.yaml.bak` backup, preserves YAML comments and ordering, and
refuses an edit that would lose comments or that changes `name`. The CLI does
not expose it.

_Relationship_: Not every Project config change needs a dedicated CLI command.
Project policy is edited directly in Project config; Rig validates the result
whenever it plans a Target and in `rig doctor`.

_Relationship_: Managed config can be stored in Project config without being
freely mutable through generic config editing. Rig detects unsafe manual
changes, such as Project identity drift, and reports them.

_Relationship_: There is no blanket `--json` flag; `--json` is per command
(status, lifecycle, deploy). Other machine-readable access comes through the
`rigd` control-plane API or the config files.

_Relationship_: There is no `rig config set` or `rig config get`. Project
config is created by `rig init`, changed by direct file edits, and validated by
`rig doctor` and whenever a Target is planned.

_Relationship_: `rig config` prints the Project name, the source path, and the
validated Project config as pretty JSON. It has no subcommands.

_Relationship_: Revision metadata and structured config editing belong to the
`rigd` control-plane API rather than the terminal response.

### Stable Target

The named non-local Target intended for durable shared use. A Project has one
Stable Target; its name defaults to `live`.

The Stable Target has a configurable name and coexists with generated Previews.
The Stable Target is not inherently a promotion stage.

_Relationship_: The Stable Target serves exactly `domain`. With no `domain`, or
no `proxy` with a `/` entry, a Target has no route. Project identity is never
inserted into a hostname. Route collisions between Projects are refused at
publish time as `ROUTE_CONFLICT`.

### Preview

A generated Target created from a Preview branch.

_Relationship_: A Preview's name is generated from its Branch (a slug plus 8 hex
digits) or given with `--deployment`. Project config controls only its
hostname: `<preview name>.<domain>` by default, or `targets.preview.domain`
with `${rig.target}` replaced by the Preview name.

_Relationship_: Preview is selected separately from local and Stable Targets,
using the `preview` selector plus a Branch.

_Relationship_: `preview` is a reserved selector and cannot be used as a
Stable Target name.

_Relationship_: `preview` cannot be used as the Working copy Target name.

_Relationship_: In CLI target selection, bare target names such as `local` or
`live` resolve to the Working copy Target or the Stable Target. Previews must be
selected with the `preview` selector, such as `rig up preview <Branch>`.

### Deploy selector

The first argument to `rig deploy` that chooses whether the deploy updates the
Stable Target or a Preview.

_Relationship_: `rig deploy` without a Deploy selector prints the deploy help.

### Working copy

The files currently checked out on disk for a project workspace.

### Branch

A named Git branch that can be pushed to Rig for deployment.
_Avoid_: ref in normal user-facing CLI

_Relationship_: Preview commands must allow Branch names containing slashes,
such as `feature/login` or `preview/main`.

_Relationship_: Rig uses conservative user-facing Branch validation:
ordinary Git branch names including slashes are allowed; whitespace and
control characters are rejected.

_Relationship_: Normal `rig` Branch arguments are local Branch names,
not remote-tracking names such as `origin/main`.

_Relationship_: CLI deploy requires any named Branch, including an
explicit Production branch for a Stable Target deploy, to exist locally so Rig
can resolve it to a Commit. Rig remote pushes are the separate path for
receiving Branches through Git.

_Relationship_: CLI Stable Target deploys without an explicit Branch still
require the configured Production branch to exist locally because Rig must
resolve that Branch to a Commit.

_Relationship_: CLI deploy preflight warns when the local Branch being deployed
is behind or ahead of its configured upstream, regardless of the upstream
remote name, and when the cached upstream ref is unavailable. These warnings
never block a deploy.

_Relationship_: CLI Stable Target deploy preflight warns when the Production
branch has no configured upstream. A Preview deploy does not warn merely
because the Preview branch has no upstream.

_Relationship_: Upstream preflight compares local Git refs only. Deploy never
fetches from remotes.

_Relationship_: There is no `rig fetch` or `rig sync`. When refs are stale or
missing, Rig guides users to run normal Git commands such as `git fetch`.

### Rig remote

A Git remote configured for a Project that sends pushed Branches to `rigd` for
deploy classification.

_Relationship_: The conventional remote name is `rig`.

_Relationship_: Rig remote deploy classification uses the pushed destination
Branch name: the Production branch deploys the Stable Target, while any other
destination Branch deploys a Preview.

_Relationship_: Pushing a new Commit to the Production branch through the Rig
remote is an explicit deploy path. It replaces the Stable Target and
brings it up without interactive confirmation.

_Relationship_: Rig remote pushes do not support `--no-up`. Use CLI deploy for materializing a Deployment without starting it.

_Relationship_: Pushing a new Commit to a non-Production branch through the Rig
remote deploys that Branch as a Preview and brings it up by default.

_Relationship_: Pushing the same Commit that is already deployed for a Target
through the Rig remote is a no-op, matching CLI deploy behavior, and does not
start a stopped Target.

_Relationship_: Rig remote classification depends on whether the pushed
destination Branch is the Production branch. A non-Production branch that
happens to share a name with a Target is still deployed as a Preview, and UI
output should disambiguate it as a Preview for that Branch.

_Relationship_: Rig remote deploys skip the local upstream/ahead/behind
preflight checks. Git push sends an exact Commit, and Rig remote deploys that
Commit according to branch policy.

### Commit

The exact Git code state a Branch resolves to at deploy time.
_Avoid_: hash in product language unless showing the SHA value

### Production branch

The branch allowed to update the Stable Target. `rig init` defaults it to the
branch `origin/HEAD` names when Rig can discover it.
_Avoid_: deployBranch

_Relationship_: Project config owns the Production branch after `rig init`;
Host config only provides the fallback for Projects that set none.

_Relationship_: The Production branch setting belongs in committed Project
config, not only in `rigd` runtime state, because it is shared Project policy.

### Preview branch

A Branch other than the Production branch that maps to a Preview.

_Relationship_: A Preview branch may contain the same code as the Production
branch, but it must have its own Branch identity, such as `preview/main`.

### Deployment

A materialized branch commit in a non-local target.
_Avoid_: using Deployment for the local Working copy lifecycle

_Relationship_: The Working copy Target uses the Working copy, while the Stable
Target and Previews use Deployments.

_Relationship_: `up` and `down` are lifecycle actions for existing Targets;
they do not create missing generated Deployments. If `rig up preview <Branch>`
names a Preview that has not been deployed yet, Rig fails and tells the
user to deploy it first.

_Relationship_: `down` stops a Target but does not remove it from inventory. A
stopped Preview still appears in interactive lifecycle selection until it is
destroyed (`rig down preview <Branch> --destroy`) or replaced at the Preview
limit.

_Relationship_: `rig down preview <Branch> --destroy` removes a Preview from
inventory with its owned route, and deletes its own data, logs, and source
history. Rig does not remove stopped Previews on its own, apart from the Host
Replacement policy at the Preview limit.

_Relationship_: Target-aware commands such as `rig up`, `rig down`, `rig
restart`, and `rig logs` show an interactive Target picker when running
in a TTY without a selected Target, and fail with `TARGET_REQUIRED` in
non-interactive use.

_Relationship_: The picker lists every Target `rig status` reports, including
ones that are only `configured`. It never creates missing Preview Deployments.

_Relationship_: `rig status` shows stopped Previews because
they remain in inventory until they are destroyed.

_Relationship_: `rig status` without arguments is Project-scoped. Host-level
project listing is `rig list`.

_Relationship_: `rig status` shows all Targets for the selected Project
rather than requiring a Target picker.

_Relationship_: `rig status` is Project-wide only; it takes no Target.

_Relationship_: `rig status` shows a compact Project report with each
Target as a heading and that Target's component state indented underneath.
Routes appear next to the component they serve when known, and a quiet
failure summary such as "No failures" is included.

### Project config

The current committed `rig.yaml` policy for a Project.
_Avoid_: using Project config to mean the recorded runtime state of an active
Target

_Relationship_: Project config is YAML only
([ADR 0001](docs/adr/0001-yaml-only-project-config-cutover.md)).

_Relationship_: User-authored YAML should remain ordinary, deterministic
configuration. Runtime records and Diagnostic logs are machine-owned state and
may remain JSON or JSONL.

_Relationship_: A deploy records the policy of the `rig.yaml` committed on the
deployed Commit; uncommitted edits never reach a Stable or Preview plan. The
working-copy config only identifies the Project, names its Targets, and
supplies the Production branch.

### Deployment record

The runtime state recorded by `rigd` for a materialized Target.
_Avoid_: Project config

_Relationship_: Lifecycle commands for the Stable Target and Previews use the
Deployment record, so they stop, start, or restart the same materialized Target
with the supervisor, ports, commands, source Branch, Commit, and resolved
component plan that Rig actually deployed. The Working copy is re-planned from
the current `rig.yaml` on `up` (when stopped) and on `restart`.

_Relationship_: `rig status` shows recorded runtime state and configured
Targets. It does not diagnose config drift.

_Relationship_: A Target or component that exists in current Project config
but has no recorded runtime state appears in status as `configured`, not
as running or stopped.

_Relationship_: `rig doctor` diagnoses drift: it compares the Working copy with
the current `rig.yaml`, and each deployed Target with the config committed in
its checkout.

### Restart

Stopping and starting the same already-materialized Target.

_Relationship_: `rig restart` is a lifecycle command, not a deploy option.
Deploy should not expose a `--restart` flag.

_Relationship_: `rig restart` may start an existing stopped Target, but it
must not materialize a missing Target or change the deployed Commit.

### Automatic restart policy

A Service's policy for revival after it exits, distinct from an explicit
Restart or start request.
_Avoid_: once-per-deploy job, absence of supervision

### Logs

Runtime output for a Target.
_Avoid_: Diagnostic log

_Relationship_: `rig logs` is Project-scoped and Target-aware. It reads
logs for an existing Target and never creates Deployments or starts stopped
Targets.

_Relationship_: `rig logs` may read logs for stopped Targets, including
stopped Previews, when logs exist.

_Relationship_: `rig logs` prints recent logs and exits by default. Streaming
logs requires an explicit `--follow` flag.

_Relationship_: `rig logs` presents all streams together, merged
chronologically across components. There is no stream filter.

_Relationship_: Each line is `HH:MM:SSZ  <component>  <marker> <line>`. The
markers are `>` stdout, `!` stderr, `~` health-check evidence, and `?` an
unknown stream.

### Redeploy

Materializing a Branch again for the same Target.

_Relationship_: A Redeploy is not a Restart; Redeploy may change code and
provider state, while Restart only cycles the current materialized Target.

_Relationship_: Deploying a new Commit or using deploy `--force` brings the
Target up by default; deploying the same already-deployed Commit is a no-op and
does not start a down Target.

_Relationship_: A failed first activation is not a completed Deployment. Retrying
its Branch and Commit may activate again while retaining Target identity and
Persistent storage. This distinction is recorded separately from stopped intent.

_Relationship_: Deploy `--no-up` materializes the Deployment without starting
the Target and is a normal user-facing option for Stable Targets and Previews.

_Relationship_: If deploy changes a Target to a new Commit, the Target moves
to that new materialized Deployment immediately. With `--no-up`, any old
running process for that Target is stopped rather than left running on
the previous Commit.

_Relationship_: When a deploy explicitly targets a Stable Target and the
Production branch resolves to a new Commit, Rig replaces the existing
Deployment without an additional confirmation prompt. Branch policy is the
safety boundary.

_Relationship_: `rig deploy <Stable Target>` deploys the Production branch to
that Stable Target; `rig deploy <Stable Target> <Branch>` deploys an explicit
Branch to that Stable Target subject to production safety policy.

_Relationship_: Normal `rig` rejects Stable Target deploys from any Branch
other than the configured Production branch.

_Relationship_: `rig deploy <Stable Target>` uses the configured Production
branch even when the current Branch differs; interactive commands confirm
this mismatch, and non-interactive commands fail with
`PRODUCTION_CONFIRMATION` unless the Production branch is passed explicitly.

_Relationship_: `rig deploy <Stable Target>` can run from detached HEAD
because it deploys the configured Production branch, not the current checkout.
If Rig detects detached HEAD, output makes clear which Production branch
is being deployed.

_Relationship_: `rig deploy <Stable Target> <Branch>` still verifies the
Branch is the configured Production branch.

_Relationship_: `rig deploy preview` deploys the current Branch as a Preview;
`rig deploy preview <Branch>` deploys an explicit Branch as a Preview.

_Relationship_: `rig deploy preview` without an explicit Branch fails
when the workspace is in detached HEAD because there is no current Branch
identity.

_Relationship_: Normal `rig` rejects Preview deploys from the Production
branch itself and suggests creating a Preview branch such as
`preview/main`.

_Relationship_: CLI Preview deploy classification uses the explicit Branch
argument, or the current Branch when omitted.

_Relationship_: Deploy never deploys the Working copy.

_Relationship_: Successful deploy output is one line,
`<project> <target> deployed <branch>@<sha> (was <sha>)`, plus any warnings and
a line per retired Preview.

_Relationship_: With `--no-up`, a warning gives the exact `rig up ...` command
for starting the materialized Target later.

_Relationship_: Deploys are Branch/Commit based, not version-bump based. There
is no `rig bump`.

### Persistent storage

Runtime data that survives Restarts and Redeploys for a Target.
_Avoid_: data root in user-facing language

### Replacement policy

The rule for what happens when a Project exceeds the Preview limit
(`deploy.generated.maxActive`, default 5; every recorded Preview counts,
running or stopped). Under `oldest`, incomplete deploys are replaced first,
then stopped Previews, then running ones; `reject` fails with `PREVIEW_LIMIT`.
Host config
owns it (`deploy.generated.maxActive` and `deploy.generated.replacePolicy`);
Project config has no override. `rigd` enforces the policy because rejecting,
replacing, or destroying Previews mutates runtime state.

### Runtime state

The machine-owned record `rigd` keeps at `<RIG_ROOT>/runtime/state.json`:
registered Projects, Targets with their Deployment records and port
selections, and the Activity log. Only `rigd` writes it, one durable replace
at a time with the previous generation kept beside it. A file written by a
different state version is refused unread. CLI and future UI views are derived
from it through `rigd`, so they agree. Daemon administration activity is
journaled beside it in `admin-activity.jsonl`, written by the `rigd` CLI.

### Port selection

Port selection probes localhost and releases every probe before returning. Recorded
port numbers exclude conflicting Rig inventory; they do not retain OS socket
ownership. Process startup and configured readiness checks still determine whether
a Target can run. Another process may acquire a selected port before startup.

### Preflight

Before a CLI deploy, `rigd` checks that the Branch exists locally and resolves
to a Commit, and collects upstream warnings. Push deploys skip it. Config is
validated when a Target is planned, not in preflight.

### Runtime plan

The resolved Rig shape that runtime execution and provider adapters consume:
the Project, the Target role and name, the workspace path, the Persistent
storage root, Branch and Commit, the process supervisor, env and env files,
builds, the hostname with its proxy routes, and the components. Each component
carries its command, ports, health check, ready timeout, restart policy, and
dependencies. The process supervisor is the single provider selection.

_Relationship_: Runtime plans are resolved by `rigd`, not by provider
adapters. Providers receive resolved context and capabilities rather than
discovering Host config, Project config, paths, ports, or policy through global
helpers.

### Provider contract

The small interface for a provider family: process supervision, proxy routing,
source materialization, Tool artifact installation, and command running. The
contracts live in `src/providers/contracts.ts`.

_Relationship_: Provider contracts are expressed in Rig domain language
and accept what they need from the runtime plan `rigd` resolved.
Providers do not read Host config, Project config, or global path helpers
directly.

_Relationship_: Project config and Host config never own the same
field. Project config owns Project intent that should travel with the repo:
commands, ports, readiness checks, builds, environment, routes, Production
branch, and Target names. Host config owns machine capability: the default
Production branch, the Preview limit, the Caddy provider settings, and
diagnostics. `rigd` combines both into the runtime plan before calling
providers.

_Relationship_: Project config can be valid Project policy even on a Host that
cannot currently satisfy it. `rig doctor` reports missing
Host capabilities rather than treating portable Project config as invalid.

_Relationship_: The one provider choice in Project config is `supervisor`:
`rigd` or `launchd`, set for the whole Project or per role under
`targets.<role>.supervisor`. A differing per-Service value is refused.

_Relationship_: Test doubles for providers live in tests. They do not appear in
config, help, or provider choices.

### Provider adapter

A focused concrete implementation of one provider contract, such as rigd
process supervision, launchd process supervision, Caddy proxy routing, Git
source materialization, or Tool artifact installation. Each provider adapter
lives in its own focused module rather than inside the provider contract
module.
