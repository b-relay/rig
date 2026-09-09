# Rig PRD: Human Output, Observability, And YAML Configuration

> Status: implemented and validated; rollout completed for available Projects. PR #74 is the single review delivery. Missing inactive rig-env-check source and unavailable Slack delivery remain explicit limitations.
> Updated: 2026-09-09.
> Sources: [completed interview](codex://threads/019de162-a710-73b2-b418-e36383393a60), through its September 9 closing decisions, and [CONTEXT.md](../CONTEXT.md).
> Implementation: [CLI observability and YAML plan](../plans/cli-observability-and-yaml.md) and [rewrite execution](../plans/typescript-rewrite.md).

This is the next increment after the [CLI/provider cleanup PRD](history.md)
and its [completed plan](history.md), tracked by #54–#62.
The requirements below describe the intended result, not currently shipped
behavior. Earlier issue closure does not establish live daemon or process health.

## Starting Problem

Normal commands render internal log levels, error tags, and large diagnostic
objects as user responses. Status mixes configured policy, recorded intent,
and observed health, so it can say a Target is running after a component dies.
Lifecycle can use newer Project config instead of the configuration that started
the Target. Application output, Rig diagnostics, and activity need distinct roles.

The pre-rewrite user-authored config was JSON-only. Discovery, initialization, registration,
editing, and Host loading need consistent YAML-first behavior without breaking
existing JSON users or rewriting their files.

## Product Baseline

Preserve the accepted Project/Target/Branch/Commit model:

- `rig` handles Project commands; `rigd` owns runtime actions and daemon
  administration: install, status, uninstall. Normal commands do not install
  or manually start the daemon.
- `local` is the Working copy Target; `live` is the Stable Target; Previews use
  `preview <branch>`. Lifecycle never materializes a missing Preview.
- Branch/Commit deploy policy, same-Commit no-ops, `--force`, `--no-up`, and
  Persistent storage preservation remain in force. A failed first activation
  remains retryable at the same Branch/Commit with its Target identity and
  Persistent storage intact; successful no-up and deliberately stopped completed
  deployments still qualify for same-Commit no-ops.
- Project config owns portable intent; Host config owns machine capability.
  Providers consume resolved context from `rigd`.
- Do not add broad `--json`, `--state-root`, generic `--config`, or stub/provider
  flags to normal commands. Structured control-plane models remain available
  for future clients.

## User Stories

1. Read a command result without decoding internal logs.
2. Trace a failed Operation across CLI and daemon diagnostics without exposing
   credentials or copying application output.
3. See fresh state for Targets and components, including partial failure,
   installed tools, and configured-only Targets.
4. Stop or restart what Rig actually deployed after current config changes.
5. Inspect a registered Project from outside its repository.
6. Read chronological component logs and, later, separate activity history.
7. Use YAML for Project and Host config while existing JSON remains supported.

## Requirements

### R1. Human Command Responses

- Bare `rig` prints help and exits successfully. `--help` and `-h` likewise
  never become internal errors.
- Use plain text, spacing, short headings, and indentation. No terminal color
  or icons are required in this increment.
- Normal responses omit log levels, tagged error names, diagnostic JSON,
  namespaces, state roots, provider names, and launchd labels.
- Usage errors explain the mistake and useful next command, without diagnostic
  paths. Still record them internally.
- Unexpected/provider failures and corrupt state receive a concise explanation,
  relevant diagnostic path when useful, and Operation ID when available. Do not
  advertise a file that was not written.
- Report final outcomes: started, stopped, deployed, failed, or unchanged.
  Transport acceptance is not completion.
- Slow deploy/start operations may show major phases such as preparing the
  deployment, starting components, and checking health. Fast commands print only
  their final response. Progress omits provider implementation details.
- Remove the global `--log-level` flag from normal `rig` and `rigd` help and
  parsing. Diagnostics default to useful info-level evidence; advanced verbosity
  belongs in Host config or the deferred Expert surface.

### R2. Diagnostic Logs And Operation Identity

- Separate User responses, Diagnostic logs, Target logs, and Activity log.
- Enable diagnostics by default with separate current JSONL files:
  `~/.rig/logs/rig/rig.jsonl` and `~/.rig/logs/rigd/rigd.jsonl`.
  Resolve equivalent paths under `RIG_ROOT` for isolated runs.
- Rotate daily into dated files, such as `rig-2026-09-08.jsonl`, and retain
  **14 days by default**. This applies to diagnostics, not Target logs, activity
  history, or Project data.
- Give each Operation one correlation ID shared across CLI and daemon logs.
  Hide it on ordinary success; show it with unexpected failures when useful.
- Record safe structured metadata and redact likely secrets. Do not dump auth
  tokens, environment values, complete configs, or arbitrary command strings.
  Target stdout/stderr belongs in Target logs; diagnostics may reference them.

### R3. Fresh Project And Component Status

`rig status` is Project-wide. Show configured and recorded Targets, including
stopped Previews, with Target headings and component details underneath. Keep
routes visible for stopped Targets without implying reachability.

```text
pantry

live  degraded  main
  web     failed   :3070  https://pantry.b-relay.com
  convex  healthy  :3290

local  configured  working copy
  web     configured  :5173

Failures
  web exited with code 1
```

- `rigd` gathers fresh, read-only provider observations of process presence,
  configured health checks, installed CLI existence/executability, and prepared
  dependency paths.
- Independent checks run concurrently within a **two-second total observation
  budget**, not two seconds per component. Startup readiness timeouts are
  separate. Unfinished checks become `unknown`; available results still render.
- Managed components are `healthy` only when a configured check passes. Process
  presence without a check means `running`; a present process with a failed
  check is `unhealthy`. Uncertain evidence is `unknown`.
- Use states appropriate to component kind: servers use healthy/running/
  starting/unhealthy/stopped/failed; tools use installed/missing/failed;
  persistent dependencies use ready/missing/failed. Unknown observations and
  configured-only components remain distinct.
- A Target is `degraded` when some expected capabilities are usable and others
  are unavailable or uncertain. Reserve `failed` for loss of expected runtime
  capability, not every partial failure. A timeout alone proves neither success
  nor failure.
- CLI-only Targets are `ready` when their tools are installed. Managed components
  determine the runtime summary for mixed CLI/server Targets; show installed
  component state separately.
- Config-defined but unrecorded Targets/components are `configured`, never
  falsely running or stopped. Distinguish an intentional stop from a crashed
  desired-running component.
- Include a quiet failure summary, such as `No failures`, when clear. Unknown
  checks remain visible so absence of recorded failures cannot imply a verified
  all-clear.
- Config drift belongs in doctor, not default status.

### R4. Current Config Versus Recorded Deployment

- Existing materialized Target up/down/restart uses the recorded providers,
  commands, ports, Branch, Commit, and component plan. Restart cycles the same
  Target; it does not deploy today's config.
- Deploy, init, config inspection/editing, and doctor use current Project config.
  Deploy is when new policy becomes recorded runtime policy. Preserve local as
  the Working copy; do not turn its lifecycle into a Branch deployment.
- `--project <name>` resolves registered context outside the repo. Current-config
  views load the registered repository's config document and validate identity.
  Runtime control resolves the recorded Target rather than adopting newer policy.
- Report missing, ambiguous, or mismatched current config honestly. Read-only
  views may show available recorded state with a warning, but cannot silently
  choose conflicting documents or invent component state. Doctor diagnoses
  path/identity and current-config-versus-deployment drift.

### R5. Command Views

| Command | Required response |
|---|---|
| `rig list` | Project identity, Target count, registered repo path; no repeated healthy daemon summary. Fail clearly if the daemon is unreachable. |
| `rig status` | Project Targets and components per R3, including when the Project is Rig itself. |
| `rig doctor` | Compact Host and optional Project summary. Expand problems and suggestions, not every passing check. Passing checks must not carry failure messages. |
| `rig config` | Validated Project config, Project identity, and source path. Replace the separate normal `read` subcommand; omit revisions and field documentation. |
| `rigd status` | Installed, running, reachable, backed by actual evidence. Omit token/state paths and launchd details from healthy output. |
| Lifecycle/deploy/init/daemon actions | Concise final outcome, with meaningful progress phases only when useful. |

`rig config` may show the readable formatted JSON agreed in the interview even
when the source is YAML. That is intentional config content, not a diagnostic
object, and does not rewrite the source file.

Doctor remains read-only, runs Host checks outside a Project, and reports daemon
unreachability while continuing independent diagnostics. It owns config drift,
identity/path conflicts, and missing Host capability. Add no implicit fetch or
repair. Rig Project status follows its actual component kinds; do not hardcode a
healthy daemon component merely because the Project is named `rig`.

### R6. Target Logs

- Automatically capture managed-component stdout/stderr in Rig-owned Target
  logs, separate from Rig diagnostics.
- `rig logs <target>` prints recent entries and exits; `--follow` streams.
  Stopped Targets remain readable when logs exist.
- Merge multiple components chronologically, prefix their names, retain useful
  timestamps, and use `>` for stdout and `!` for stderr.

```text
pantry live

09:42:11  web     > Server ready
09:42:12  web     ! Optional cache unavailable
09:42:14  convex  > Backend ready
```

Reading logs never starts processes or materializes Deployments. Defer custom
per-component destinations; do not add log-sink fields now.

### R7. YAML-First User Configuration

| Scope | New canonical file | Supported existing file |
|---|---|---|
| Project | `<repo>/rig.yaml` | `<repo>/rig.json` |
| Host | `~/.rig/config.yaml` | `~/.rig/config.json` |

- New files use YAML. Valid JSON is fully supported without a doctor warning
  merely about format.
- Support `.yaml` and legacy `.json`, not `.yml`.
- Both filenames present for one config is an ambiguity error. Do not prefer,
  merge, or fall back to JSON when YAML is invalid.
- Accept one YAML 1.2 document with comments. Reject duplicate keys, custom
  tags, anchors, aliases, merge keys, and multiple documents before domain
  validation. Both formats feed the same Zod schema for their scope.
- Apply the same policy across discovery, init, loading, registration, doctor,
  config inspection, and existing structured editing paths.
- **No configuration migration command and no automatic format migration.** Users may convert
  manually; Rig never silently renames, converts, or deletes existing JSON.
- Runtime state and diagnostics remain machine-owned JSON/JSONL.
- Structured writers editing existing YAML must preserve comments and ordering
  or refuse safely. Preserve revision checks, validation, and backups for
  existing editor operations. YAML reading must not enable lossy JSON-based
  writers to overwrite human-maintained YAML.

### R8. Activity History — Follow-On Phase

After cleaning existing output and diagnostics, add `rig activity` using the same
presentation model and `rigd` journal evidence.

- Include attempted Operations reaching `rigd` with succeeded, failed, and
  unchanged/no-op final outcomes. Exclude usage mistakes that attempted nothing.
- Preserve meaningful lifecycle, deploy, registration, daemon, and crash events.
- Show what happened separately from diagnostics/application streams. Never
  render an acceptance receipt as completed success.
- Call this an Activity log, not an audit trail with unimplemented retention,
  immutability, identity, or tamper-evidence guarantees.

Establish final-outcome evidence during earlier slices. Optional activity
filters in interview examples are not required command contracts in this PRD.

## Scope And Dependencies

Deliver R1–R7 first, then R8. Fresh observations and final Operation outcomes are
prerequisites for corresponding user claims. The pre-rewrite file-based daemon
marker and in-process runtime do not prove reachability or durable ownership;
the plan must establish the required runtime evidence before calling them done.

The completed interview originally kept adjacent issues separate. The later
September 9 authorization expands implementation to all open issues #64–#73:
local workspace/shutdown (#64/#65), partial recovery/crash status (#66/#67),
stopped-Project rename/repoint (#68), independent source ownership (#69),
identity/doctor (#70/#71), scoped structured output (#72), and ref retention
(#73). These additions retain the interview decision against broad JSON flags.

Out of scope: Expert/`rigx`, full web UI, remote hosts, project deletion,
automatic Preview cleanup, custom/multiple Stable stages, automatic doctor
repair, generic normal-CLI config writes, custom log sinks, config migration
commands, and blanket JSON-output flags. Preserve runtime data per the
[state preservation policy](state-preservation-policy.md).

Follow-up #78 makes interrupted effect checkpoint preparation recoverable through
normal Target recovery. Proven preparations can be cleaned; pre-marker backups
are preserved with a reported archive location before retry. Corrupt or ambiguous
evidence stays protected under the state preservation policy.

## Acceptance And Validation

Use public-behavior TDD slices from the linked plan. Cover external effects,
partial failure, timeouts, managed/installed components, both config formats,
and both CLI entrypoints. Isolate `RIG_ROOT`, provider paths, processes, and
ports. Constant statuses and captured calls alone cannot establish runtime
claims. Run focused tests, full tests, build, and type-checking; distinguish
pre-existing failures from regressions. Update user docs as behavior ships,
without advertising planned YAML, activity, or daemon functionality as available.

## September 9 Implementation Authorization

The subsequent implementation request supersedes the Effect stack: use strict
plain TypeScript, Bun, Zod, and explicit provider interfaces. Finish this PRD
and all open GitHub issues, with independent review after major milestones.
The narrower issue #72 structured status/lifecycle output is now in scope:
command-specific `--json` renders the same read model, without reintroducing a
global output flag. Issue #68 authorizes a supported explicit Project repoint
and rename workflow; design it with stopped Targets and validated conflicts
before mutating identity/path ownership.

The later rollout instruction explicitly authorizes upgrading existing Rig
Projects after battle testing, with inventory, exact backups, verified provider
ownership, and preserved Persistent storage. This is a deliberate runtime
compatibility cutover, not an automatic migration in normal commands. It does
not authorize Project data deletion or conversion of existing JSON config to
YAML. Historical source uncertainty must be resolved with recorded evidence;
current config cannot invent a deployed Branch or Commit.

Delivery is one large PR from the implementation branch, followed by its link
in Slack when the session has that capability. Independent reviews followed
each major milestone. Full release validation, ticket acceptance, and the backed-up
rollout to available Projects are recorded in
[the live results](reviews/2026-09-09-live-rollout-results.md) and
[PR #74](https://github.com/b-relay/rig/pull/74). The missing inactive
rig-env-check source and unavailable Slack connector/browser remain explicit.
Pantry resumes its existing deployment with a pinned backend and no production
push; its intentional recorded-policy drift is documented rather than redeployed.
Current evidence is in the [milestone review](reviews/2026-09-09-rewrite-milestones.md),
[config review](reviews/2026-09-09-config-contracts.md), and
[legacy migration review](reviews/2026-09-09-legacy-migration.md).

Follow-up #79 makes capture-backed launchd status use fresh, ownership-verified
application observations. Backoff renders starting, recovered applications report
their own PID, and exhausted retries retain terminal failure evidence. Legacy or
unverifiable capture evidence remains unknown until a deliberate wrapper upgrade.
See the [capture observation evidence](reviews/2026-09-09-issue-79-capture-observations.md).
