# Rig Context

This is the accepted domain model and product contract, including planned
interaction behavior. It is not a release-completion record. The current
implementation uses plain strict TypeScript/Bun/Zod without Effect TS; consult
the [PRD](docs/PRD.md), [module map](README.md#module-map), and
[cutover readiness](docs/rig-cutover-readiness.md) for implementation scope and gates.

## Terms

### Rig

The local Mac deployment system as a whole. Rig is repo-first,
lifecycle-first, and provider-backed. It should not preserve older
env/service/release assumptions unless that compatibility has a clear,
short-lived operational purpose.

### rig

The normal user CLI for project lifecycle, deploy, status, diagnostics, and
safe project management actions.

### rigd

The Rig runtime authority daemon. `rigd` is the only module that should mutate
runtime state for lifecycle and deploy actions: deployment inventory,
Preview materialization, port reservations, runtime events,
receipts, health state, and process execution all sit behind `rigd`.

_Relationship_: A future Rig web UI should be a client of `rigd` through a
control-plane API, not logic deeply embedded in daemon internals.

_Relationship_: The first control-plane transport should be localhost HTTP,
bound to `127.0.0.1` only and protected by a local auth token. This keeps the
CLI and future UI simple while avoiding network exposure.

_Relationship_: The local control-plane auth token belongs in Host/user Rig
state, not committed Project config, because it is a machine credential for
talking to local `rigd`.

### rigd CLI

The daemon administration CLI for installing, uninstalling, and checking the
status of `rigd`; it should not expose broad manual daemon control.

_Relationship_: User-facing inventory commands such as Project listing belong
to `rig`, even when `rig` queries `rigd` for the data. The `rigd` CLI should
remain limited to daemon administration.

_Relationship_: `rigd install` should create the local control-plane auth
token as part of daemon setup.

_Relationship_: `rigd uninstall` should remove daemon administration artifacts
such as the local control-plane auth token, but it must not delete Project
Persistent storage or other destructive Project state without a future deletion
design.

_Relationship_: `rigd uninstall` should refuse by default when Rig-managed
Targets are running and guide the user to stop them first, so uninstall does
not leave unmanaged processes or routes behind.

_Relationship_: Unresolved Target recovery also blocks uninstall, even when
the candidate is stopped. Keep daemon control available so explicit `rig down`
can finish recovery before uninstall is retried.

_Relationship_: `rigd uninstall --force` should not be part of the first
release. Bulk stop/delete cleanup semantics require separate design.

_Relationship_: `rigd status` should report daemon installation, running, and
reachability state. It may include high-level counts, but detailed Project and
Target status belongs to `rig list` and `rig status`.

_Relationship_: The normal `rigd status` response should stay focused on
daemon administration state: installed, running, and reachable. The Rig
Project's own Targets and components belong to `rig status`, even when `rigd`
is one of those components.

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

_Relationship_: `rig activity` should be added after the User response and
Diagnostic log model is cleaned up. Activity history should be presented
through the same user-output model as other commands rather than as another
one-off formatter.

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

The user-authored configuration for one Host, stored canonically at
`~/.rig/config.yaml`.

_Relationship_: Existing `~/.rig/config.json` files remain readable for
compatibility, but Rig should create and prefer YAML for new Host config.

_Relationship_: If both `config.yaml` and `config.json` exist, Rig should fail
with a clear ambiguity error rather than silently choosing or merging them.

_Relationship_: Host config migration is manual. Rig should not expose a
config migration command or silently rewrite an existing JSON file.

_Relationship_: Runtime records and Diagnostic logs are machine-owned state,
not Host config, and may remain JSON or JSONL.

### Project deletion

The destructive removal of a Rig project and some or all associated state;
this requires a dedicated design before implementation.
_Avoid_: archive, unrig

### Expert surface

The advanced Rig interface for development, testing, isolated state roots,
provider profiles, low-level diagnostics, and daemon administration.
_Unresolved_: this may become a separate `rigx` executable, an expert mode
enabled in home config, or remain internal for longer.

_Relationship_: The first release should not expose a normal user-facing
expert mode. Stub providers, state-root overrides, and similar advanced
testing surfaces should remain test/dev/internal mechanisms until a dedicated
expert surface is designed.

_Relationship_: `--state-root` should not be exposed on normal `rig` commands.
State-root overrides are test/dev/internal mechanisms, not normal Project
lifecycle or deploy options.

_Relationship_: Diagnostic-log verbosity should not be exposed as a normal
global `--log-level` flag. Advanced verbosity control belongs in Host config or
the future Expert surface.

_Relationship_: Generic `--config` path overrides should not be exposed on
normal `rig` commands. Normal commands discover Project config from the
workspace or `--project`, and Host config from the current user/Host.

_Relationship_: Package-script and provider-profile flags should not be
exposed on normal `rig` commands. Package/script behavior belongs in Project or
provider config, while provider profiles and stubs are test/dev/internal
surfaces.

### Deploy intent

The classification of a requested deploy. Deploy intent answers what Target a
Branch maps to, such as a Stable Target or a Preview, and may carry optional
metadata. Deploy intent does not materialize Deployments, enforce Preview caps,
write inventory, reserve ports, or start processes.

### Target

The user-facing runtime object a Rig command acts on, such as the Working copy
Target, a Stable Target, or a Preview.
_Avoid_: lane when speaking about the user-facing CLI

### Component

A named Project capability managed or prepared within a Target, such as a
server, installed CLI, database, or provider-backed dependency.

_Relationship_: Component state should use vocabulary appropriate to the
component kind. Managed servers may be healthy, running, starting, unhealthy,
stopped, or failed; installed CLIs may be installed, missing, or failed; and
persistent dependencies may be ready, missing, or failed.

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

_Relationship_: A Target is `degraded` when some expected components are
usable and others are unhealthy, failed, missing, or unknown. `failed` is
reserved for a Target that cannot provide any of its expected runtime
capabilities.

_Relationship_: A Target containing only installed components is `ready` when
they are installed. For a Target containing managed and installed components,
the managed components determine whether the Target is running, degraded, or
failed.

_Relationship_: Configured routes should remain visible in `rig status` when a
Target is stopped. The Target and component states communicate that the route
is not currently available.

### Working copy Target

The Target backed by the current Working copy, with a configurable alias that
defaults to `local`.

_Relationship_: The first release uses `local` as the Working copy Target
name; the model should leave room for renaming it later.

_Relationship_: The Working copy Target name and Stable Target names must be
unique.

_Relationship_: The Working copy Target name belongs in committed Project
config as the default Project policy. Future user or Host overrides may rename
it locally, but the first release should use the Project config default.

### Project

A repo or app managed by Rig.
_Avoid_: product name

_Relationship_: Project identity used for routing should be chosen during
`rig init`. Interactive init should default to a slug from the repository root
directory name and allow the user to accept or change it. Non-interactive init
should use the default unless explicitly provided.

_Relationship_: Project identity must be unique per Host because it
participates in routing and explicit `--project <name>` selection. `rigd`
should reject registering a different Project with the same identity, while
allowing idempotent initialization of the same Project.

_Relationship_: `--project <name>` selects the configured Project identity
known to `rigd`, not the filesystem folder name. The folder name is only the
default suggestion during initialization.

_Relationship_: Project identity belongs in committed Project config because
it affects routing, explicit Project selection, and Host-level uniqueness.

_Relationship_: Project identity is managed config. `rig init` creates it, but
normal config editing should not expose identity as a simple settable field.
Changing identity requires a future dedicated rename design that coordinates
Project config, `rigd` inventory, routes, and storage.

_Relationship_: `rig list` is a Host-level Project inventory command. It
lists Projects with summary metadata such as Target count, but it does not show
every Target for every Project.

_Relationship_: `rig list` should read runtime inventory from `rigd` and fail
when `rigd` is unreachable, rather than falling back to potentially stale local
files.

_Relationship_: The normal `rig list` response should show each Project's
identity, Target count, and registered repository path. It should not repeat a
healthy daemon summary.

_Relationship_: Project-scoped commands such as `rig status`, `rig up`, `rig
down`, `rig restart`, `rig deploy`, and `rig logs` require a Project context.
They should
resolve Project context from the current workspace or from an explicit
`--project <name>` that matches a Project known to `rigd`; otherwise they fail
with guidance to run inside a Project or use `rig list`.

_Relationship_: Normal `rig` commands should not install `rigd`
automatically. If `rigd` is missing, they should fail with guidance to run
`rigd install`.

_Relationship_: Normal `rig` commands should not manually start `rigd` when it
is installed but unreachable. Daemon lifecycle belongs to `rigd install` and
launchd; normal commands should report the problem and suggest `rigd status`.

_Relationship_: `rig doctor` is both Host-aware and Project-aware. It should
always run Host diagnostics, and when a Project context is available it should
also run diagnostics for that Project. It should not require a flag to choose
between Host and Project checks.

_Relationship_: `rig doctor` may succeed outside a Project workspace with
Host-only diagnostics and a clear note that Project checks were skipped.

_Relationship_: `rig doctor --project <name>` should run Host diagnostics plus
diagnostics for the named Project when it is known to `rigd`.

_Relationship_: `rig doctor` should still run diagnostics that do not require
`rigd` when the daemon is unreachable, and report daemon reachability as a
finding.

_Relationship_: `rig doctor` is read-only by default. Any repair behavior must
be explicit and designed separately.

_Relationship_: `rig doctor` should report when committed Project config
identity differs from the Project identity registered in `rigd`.

_Relationship_: If repair behavior is added later, `rig doctor --fix` is the
preferred user-facing shape, but its exact automation and confirmation behavior
must be decided as part of the future repair design.

_Relationship_: `rig doctor` should not fetch from remotes implicitly. It
should diagnose Git branch state from local refs only.

_Relationship_: A healthy `rig doctor` response should summarize Host health
and, when present, Project health, followed by a quiet confirmation that no
problems were found. Detailed checks, suggestions, and Diagnostic log paths
should be expanded only for problems.

### Project initialization

Registering a Project with Rig and writing the project configuration needed for
Rig commands to resolve Project policy.

_Relationship_: `rig init` should configure the Rig remote when possible
because `git push rig <Branch>` is a core deploy path.

_Relationship_: `rig init` requires `rigd` to be installed and reachable for
full Project registration. It may write or validate Project config locally, but
it should not claim success unless registration with `rigd` succeeds.

_Relationship_: If `rig init` writes Project config but registration with
`rigd` fails, it should not automatically roll back the file. It should report
the partial initialization clearly, and `rig doctor` should be able to diagnose
the mismatch.

_Relationship_: Rerunning `rig init` after partial initialization should be
idempotent. If Project config already exists and matches the workspace, `rig
init` should continue registration with `rigd` rather than starting over.

_Relationship_: `rig init` should fail if existing Project config has a
Project identity already registered in `rigd` to a different Project path.
`rig doctor` should report this as a Project identity/path conflict.

_Relationship_: Moving a Project directory should require a future explicit
move or repair flow. Rig should not automatically update registered Project
paths just because it sees the same Project config at a new location.

_Relationship_: Copying a Project repository to a second folder may become a
new Rig Project on the same Host if the user chooses a new Project identity and
the resulting routes do not collide.

_Relationship_: `rig init` must not overwrite an existing Git remote named
`rig` that points somewhere else. It should stop with guidance instead.

_Relationship_: If a Git remote named `rig` already points to the expected Rig
remote URL, `rig init` should treat it as already configured and continue.

_Relationship_: `rig init` may run from any subdirectory inside a Git
repository, but it should write Project config at the repository root and tell
the user where it wrote it.

_Relationship_: If `rig init` runs outside a Git repository in an interactive
TTY, it may warn that Rig needs Git and ask whether to create a new Git
repository before continuing. Non-interactive initialization should fail unless
the user explicitly chooses a Git creation path.

_Relationship_: When the user confirms Git repository creation during
interactive `rig init`, Rig may run `git init` and then continue initialization.

_Relationship_: `rig init` should not create Git commits. Deploy commands
should fail clearly until the relevant Branch resolves to a Commit.

_Relationship_: If `rig init` runs in a repository with no commits, it should
choose the pending Production branch from Git's configured initial branch when
available, otherwise default to `main`.

_Relationship_: Interactive `rig init` should show the detected or default
Production branch and allow the user to accept or change it. Non-interactive
initialization should use the detected or default value unless an explicit
Production branch option is provided.

### Config editing

Reading or changing Rig configuration through Rig commands.

_Relationship_: User-authored Host and Project config use `.yaml` as the
canonical YAML extension. Rig should not also accept `.yml`; the only alternate
format is the supported legacy `.json` filename.

_Relationship_: A valid legacy JSON config is supported rather than deprecated.
`rig doctor` should not report a problem solely because a Host or Project still
uses JSON. YAML preference means new files and documentation use YAML.

_Relationship_: YAML config should accept one ordinary YAML 1.2 document and
comments. Rig should reject duplicate keys, custom tags, anchors, aliases,
merge keys, and multiple documents so configuration remains deterministic.

_Relationship_: Future structured config writers, including a Rig UI, should
preserve YAML comments and ordering. If an edit cannot be applied without
unexpectedly rewriting human-maintained structure, the writer should refuse
the edit.

_Relationship_: Generic project config reads are useful, but generic project
config writes should be allowlisted. Managed fields such as Project identity
should not be exposed as simple `rig config set` targets.

_Relationship_: Not every Project config change needs a dedicated CLI command.
Some advanced or structured Project policy may be edited directly in Project
config or through a future Rig UI, as long as Rig validates the resulting config
through preflight and diagnostics.

_Relationship_: Managed config can be stored in Project config without being
freely mutable through generic config editing. Rig should detect unsafe manual
changes, such as Project identity drift, and report them through `rig doctor`.

_Relationship_: Normal `rig` commands should not add blanket `--json` output
flags in the first release. Machine-readable access should come through the
`rigd` control-plane API or direct config files unless a specific command needs
structured output.

_Relationship_: `rig config get` is optional for the first release. If present,
it should be read-only and focused rather than a broad configuration API.

_Relationship_: `rig config set` should be omitted from the first cleanup
slice. Project config should be created by `rig init`, advanced changes may be
made by direct file edits, and `rig doctor`/preflight should validate the
result.

_Relationship_: `rig config` with no subcommand should show the validated
Project config in readable form and identify its source path. A separate
`read` subcommand is unnecessary.

_Relationship_: Revision metadata, field documentation, and structured config
editing belong in the `rigd` control-plane API or a future Rig UI rather than
the normal terminal response.

### Stable Target

A named non-local Target intended for durable shared use. The first Stable
Target defaults to `live`.

_Relationship_: The first release has one Stable Target; the model should
leave room for future ordered Stable stages such as `alpha`, `beta`, and
`prod`, with promotion between stages.

_Relationship_: The first release uses `live` as the Stable Target name; the
model should leave room for renaming it and adding more Stable Target names
later.

_Relationship_: Stable Target names belong in committed Project config. The
first release may only support the default `live`, but storing it as config
keeps Project policy explicit and migration-ready.

_Relationship_: Default Stable Target routing should include Project identity
so Stable Targets from different Projects do not collide.

### Preview

A generated Target created from a Preview branch.

_Relationship_: Preview naming and routing policy, such as deriving subdomains
from Branch names, belongs in committed Project config.

_Relationship_: Default Preview routing should include Project identity as
well as Branch identity so Previews from different Projects do not collide.

_Relationship_: Preview is selected separately from local and Stable Targets,
using the `preview` selector plus a Branch.

_Relationship_: `preview` is a reserved selector and cannot be used as a
Stable Target name.

_Relationship_: `preview` cannot be used as the Working copy Target name.

_Relationship_: In CLI target selection, bare target names such as `local` or
`live` resolve to the Working copy Target or Stable Targets. Previews must be
selected with the `preview` selector, such as `rig up preview <Branch>`.

### Deploy selector

The first argument to `rig deploy` that chooses whether the deploy updates a
Stable Target or a Preview.

_Relationship_: `rig deploy` without a Deploy selector is invalid and should
show the valid Stable Target name and `preview` forms.

### Working copy

The files currently checked out on disk for a project workspace.

### Branch

A named Git branch that can be pushed to Rig for deployment.
_Avoid_: ref in normal user-facing CLI

_Relationship_: Preview commands must allow Branch names containing slashes,
such as `feature/login` or `preview/main`.

_Relationship_: Rig should use conservative user-facing Branch validation:
allow ordinary Git branch names including slashes, but reject whitespace and
control characters.

_Relationship_: Normal `rig` Branch arguments should be local Branch names,
not remote-tracking names such as `origin/main`.

_Relationship_: CLI deploy should require any named Branch, including an
explicit Production branch for a Stable Target deploy, to exist locally so Rig
can resolve it to a Commit. Rig remote pushes are the separate path for
receiving Branches through Git.

_Relationship_: CLI Stable Target deploys without an explicit Branch still
require the configured Production branch to exist locally because Rig must
resolve that Branch to a Commit.

_Relationship_: CLI deploy preflight for Stable Targets and Previews should
warn when the local Branch being deployed is behind its configured upstream,
regardless of the upstream remote name. This warning does not block deploy by
default.

_Relationship_: CLI deploy preflight for Stable Targets and Previews should
also warn when the local Branch being deployed is ahead of its configured
upstream. This warning does not block deploy by default.

_Relationship_: CLI Stable Target deploy preflight should warn when the
Production branch has no configured upstream. CLI Preview deploy should not
warn merely because the Preview branch has no configured upstream.

_Relationship_: CLI deploy upstream preflight should compare local Git refs
only. Deploy should not fetch from remotes implicitly.

_Relationship_: Rig should not add a `rig fetch` or `rig sync` wrapper for
Git remote refs. When refs are stale or missing, Rig should guide users to run
normal Git commands such as `git fetch`.

### Rig remote

A Git remote configured for a Project that sends pushed Branches to `rigd` for
deploy classification.

_Relationship_: The conventional remote name is `rig`.

_Relationship_: Rig remote deploy classification uses the pushed destination
Branch name: the Production branch deploys the Stable Target, while any other
destination Branch deploys a Preview.

_Relationship_: Pushing a new Commit to the Production branch through the Rig
remote is an explicit deploy path. It should replace the Stable Target and
bring it up by default without interactive confirmation.

_Relationship_: Rig remote pushes do not support `--no-up` in the first
release. Use CLI deploy for materializing a Deployment without starting it.

_Relationship_: Pushing a new Commit to a non-Production branch through the Rig
remote deploys that Branch as a Preview and brings it up by default.

_Relationship_: Pushing the same Commit that is already deployed for a Target
through the Rig remote is a no-op, matching CLI deploy behavior, and should not
start a stopped Target.

_Relationship_: Rig remote classification depends on whether the pushed
destination Branch is the Production branch. A non-Production branch that
happens to share a name with a Target is still deployed as a Preview, and UI
output should disambiguate it as a Preview for that Branch.

_Relationship_: Rig remote deploys should not run local upstream/ahead/behind
preflight checks. Git push sends an exact Commit, and Rig remote deploys that
Commit according to branch policy.

### Commit

The exact Git code state a Branch resolves to at deploy time.
_Avoid_: hash in product language unless showing the SHA value

### Production branch

The branch allowed to update a Stable Target; defaults to the repository's
default branch when Rig can discover it.
_Avoid_: deployBranch

_Relationship_: Project config owns the Production branch after `rig init`;
home config may only provide a fallback before project policy exists.

_Relationship_: The Production branch setting belongs in committed Project
config, not only in `rigd` runtime state, because it is shared Project policy.

### Preview branch

A Branch other than the Production branch that maps to a Preview.

_Relationship_: A Preview branch may contain the same code as the Production
branch, but it must have its own Branch identity, such as `preview/main`.

### Deployment

A materialized branch commit in a non-local target.
_Avoid_: using Deployment for the local Working copy lifecycle

_Relationship_: The Working copy Target uses the Working copy, while Stable
Targets and Previews use Deployments.

_Relationship_: `up` and `down` are lifecycle actions for existing Targets;
they do not create missing generated Deployments. If `rig up preview <Branch>`
names a Preview that has not been deployed yet, Rig should fail and tell the
user to deploy it first.

_Relationship_: `down` stops a Target but does not remove it from inventory. A
stopped Preview should still appear in interactive lifecycle selection until a
separate cleanup or deletion policy removes it.

_Relationship_: Preview cleanup is part of the future deletion design, not
first-release lifecycle behavior. Rig should not automatically remove stopped
Previews until deletion semantics are designed.

_Relationship_: Target-aware commands such as `rig up`, `rig down`, `rig
restart`, and `rig logs` should show an interactive Target picker when running
in a TTY without a selected Target, and fail with guidance in non-interactive
use.

_Relationship_: Interactive lifecycle selection should show `local`, Stable
Targets, and existing Previews, but should not create missing Preview
Deployments.

_Relationship_: `rig status` should show stopped Previews by default because
they remain in inventory until a separate cleanup or deletion policy removes
them.

_Relationship_: `rig status` without arguments is Project-scoped. Host-level
project listing should use a separate command shape, such as `rig list`.

_Relationship_: `rig status` should show all Targets for the selected Project
by default, rather than requiring a Target picker.

_Relationship_: The first release should keep `rig status` Project-wide only;
Target-filtered status can be added later if needed.

_Relationship_: `rig status` should show a compact Project report with each
Target as a heading and that Target's component state indented underneath.
Routes should appear next to the component they serve when known, and a quiet
failure summary such as "No failures" should be included.

### Project config

The current committed `rig.yaml` policy for a Project.
_Avoid_: using Project config to mean the recorded runtime state of an active
Target

_Relationship_: `rig.yaml` is the canonical Project config filename, and
`rig init` should create YAML. Existing `rig.json` files remain readable for
compatibility.

_Relationship_: If both `rig.yaml` and `rig.json` exist in one Project, Rig
should fail with a clear ambiguity error rather than silently choosing or
merging them.

_Relationship_: Project config migration is manual. Rig should not expose a
config migration command or silently rewrite an existing JSON file.

_Relationship_: User-authored YAML should remain ordinary, deterministic
configuration. Runtime records and Diagnostic logs are machine-owned state and
may remain JSON or JSONL.

_Relationship_: Deploy, init, config editing, and doctor use current Project
config. A deploy is the moment when current Project config becomes the recorded
runtime policy for the deployed Target.

### Deployment record

The runtime state recorded by `rigd` for a materialized Target.
_Avoid_: Project config

_Relationship_: Lifecycle commands for an existing Target should use the
Deployment record so they stop, start, or restart the same materialized Target
with the provider choices, ports, commands, source Branch, Commit, and resolved
component plan that Rig actually deployed.

_Relationship_: `rig status` should primarily show recorded runtime state and
configured Targets. It should not diagnose config drift by default.

_Relationship_: A Target or component that exists in current Project config
but has no recorded runtime state should appear in status as `configured`, not
as running or stopped.

_Relationship_: `rig doctor` should diagnose drift between current Project
config and Deployment records, including command, port, provider, component,
or route differences.

### Restart

Stopping and starting the same already-materialized Target.

_Relationship_: `rig restart` is a lifecycle command, not a deploy option.
Deploy should not expose a `--restart` flag.

_Relationship_: `rig restart` may start an existing stopped Target, but it
must not materialize a missing Target or change the deployed Commit.

### Logs

Runtime output for a Target.
_Avoid_: Diagnostic log

_Relationship_: `rig logs` is Project-scoped and Target-aware. It should read
logs for an existing Target and should not create Deployments or start stopped
Targets.

_Relationship_: `rig logs` may read logs for stopped Targets, including
stopped Previews, when logs exist.

_Relationship_: `rig logs` prints recent logs and exits by default. Streaming
logs requires an explicit `--follow` flag.

_Relationship_: `rig logs` should present stdout and stderr together by
default, with room for future filtering if users need separate streams.

_Relationship_: When a Target has multiple components, `rig logs` should merge
their entries chronologically and prefix each entry with its component name.

_Relationship_: Default human log output should use compact stream markers:
`>` for stdout and `!` for stderr. It should not repeat full stdout/stderr labels
on every line.

### Redeploy

Materializing a Branch again for the same Target.

_Relationship_: A Redeploy is not a Restart; Redeploy may change code and
provider state, while Restart only cycles the current materialized Target.

_Relationship_: Deploying a new Commit or using deploy `--force` brings the
Target up by default; deploying the same already-deployed Commit is a no-op and
does not start a down Target.

_Relationship_: Deploy `--no-up` materializes the Deployment without starting
the Target and is a normal user-facing option for Stable Targets and Previews.

_Relationship_: If deploy changes a Target to a new Commit, the Target should
move to that new materialized Deployment immediately. With `--no-up`, any old
running process for that Target should be stopped rather than left running on
the previous Commit.

_Relationship_: When a deploy explicitly targets a Stable Target and the
Production branch resolves to a new Commit, Rig should replace the existing
Deployment without an additional confirmation prompt. Branch policy is the
safety boundary.

_Relationship_: `rig deploy <Stable Target>` deploys the Production branch to
that Stable Target; `rig deploy <Stable Target> <Branch>` deploys an explicit
Branch to that Stable Target subject to production safety policy.

_Relationship_: Normal `rig` rejects Stable Target deploys from any Branch
other than the configured Production branch.

_Relationship_: `rig deploy <Stable Target>` uses the configured Production
branch even when the current Branch differs; interactive commands should
confirm this mismatch, and non-interactive commands should pass the Production
branch explicitly.

_Relationship_: `rig deploy <Stable Target>` can run from detached HEAD
because it deploys the configured Production branch, not the current checkout.
If Rig detects detached HEAD, output should make clear which Production branch
is being deployed.

_Relationship_: `rig deploy <Stable Target> <Branch>` still verifies the
Branch is the configured Production branch.

_Relationship_: `rig deploy preview` deploys the current Branch as a Preview;
`rig deploy preview <Branch>` deploys an explicit Branch as a Preview.

_Relationship_: `rig deploy preview` without an explicit Branch should fail
when the workspace is in detached HEAD because there is no current Branch
identity.

_Relationship_: Normal `rig` rejects Preview deploys from the Production
branch itself and should suggest creating a Preview branch such as
`preview/main`.

_Relationship_: CLI Preview deploy classification uses the explicit Branch
argument, or the current Branch when omitted.

_Relationship_: Deploy never deploys the Working copy.

_Relationship_: Successful deploy output should name the materialized Target
and include concise next commands for common follow-up actions such as `up`,
`logs`, and `status`.

_Relationship_: Successful deploy output with `--no-up` should still include
the exact `rig up ...` command for starting the materialized Target later.

_Relationship_: `rig bump` should be removed. Deploys are Branch/Commit based,
not version-bump based.

_Relationship_: CLI cleanup should be implemented as tracer-bullet vertical
slices. Start with one clean path end to end, such as `rig init`, `rig deploy
live`, `rig status`, and `rig list` basics, while removing conflicting flags.
Then add Preview, lifecycle, and logs slices.

### Persistent storage

Runtime data that survives Restarts and Redeploys for a Target.
_Avoid_: data root in user-facing language

### Replacement policy

The rule for what happens when Previews exceed the active cap.
Home config owns the machine default, and project config may later override it
when a repo needs different behavior. `rigd` enforces the policy because
rejecting, replacing, or destroying Previews mutates runtime state.

### Runtime journal

The internal `rigd` module that records runtime evidence: accepted receipts,
runtime events, health summaries, provider observations, deployment snapshots,
port reservations, desired deployment state, and managed process failures.
Callers do not write the runtime journal directly.

### Read model

A derived view of runtime journal evidence, shaped for CLI and web consumers.
Project lists, deployment rows, health snapshots, and log windows should come
from read models so CLI and web views agree.

### Preflight

The safety gate `rigd` runs before lifecycle or deploy actions mutate runtime
state. Preflight gathers evidence about dependencies, binaries, env, hooks,
health ownership, ports, provider readiness, and stale state. Doctor reports
the same evidence for humans, but `rigd` owns enforcing the gate.

### Runtime plan

The resolved Rig shape that runtime execution, preflight, and provider
adapters consume. The runtime plan uses Rig concepts: Projects, Targets,
Deployments, Branches, Commits, managed components, installed components,
workspace roots, Persistent storage roots, log roots, runtime roots, proxy
config, provider selections, hooks, env, health, and dependencies. Older
`Environment`, `server`, `bin`, `dev`, `prod`, `lane`, and generated
deployment language is historical context, not the active product model.

_Relationship_: Runtime plans are resolved by `rigd`, not by provider
adapters. Providers receive resolved context and capabilities rather than
discovering Host config, Project config, paths, ports, or policy through global
helpers.

### Provider contract

The small interface for a provider family, such as process supervision, proxy
routing, workspace materialization, health checking, event transport, lifecycle
hooks, package management, SCM, tunnel exposure, or control-plane transport.

_Relationship_: Provider contracts should be expressed in Rig domain language
and should accept resolved provider context from `rigd`. Providers should not
read home config, Project config, or global path helpers directly.

_Relationship_: Provider calls should use a consistent shape: shared Runtime
context plus typed provider-specific config. The shared Runtime context carries
domain facts and capabilities common to providers; provider-specific config
carries settings only that provider understands, such as Caddyfile path for a
Caddy proxy provider.

_Relationship_: Provider-specific config may be resolved from both committed
Project config and Host config, but those configs should avoid owning the same
field. Project config owns Project intent that should travel with the repo,
such as commands, health paths, route shape, Production branch, Target names,
and Preview naming policy. Host config owns machine capability, such as local
tool paths, base domains, port ranges, runtime roots, auth tokens, daemon
address, and installed provider defaults. `rigd` combines Project intent and
Host capability into the runtime plan before calling providers.

_Relationship_: Project config can be valid Project policy even on a Host that
cannot currently satisfy it. `rig doctor` and preflight should report missing
Host capabilities rather than treating portable Project config as invalid.

_Relationship_: Provider selections in config should use stable readable IDs,
such as `proxy.caddy` or `process.launchd`, to avoid collisions as third-party
providers are added. CLI and UI may present friendlier display names.

_Relationship_: Stub providers are for tests, development, and expert
diagnostics. They should not appear in normal generated Project config, normal
help, or normal user-facing provider choices.

_Relationship_: Future third-party provider/plugin support should use the same
contract shape as first-party providers instead of a separate plugin-only API.

### Provider adapter

A focused concrete implementation of one provider contract, such as rigd
process supervision, launchd process supervision, Caddy proxy routing, git
worktree materialization, native health checks, package.json script installs,
or stub providers. Each provider adapter should live in its own focused module
rather than inside the provider contract module.
