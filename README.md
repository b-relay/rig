# rig

Local Mac deployment manager.

`rig` runs, inspects, and deploys local projects on one computer. It is
repo-first, written in strict TypeScript with Bun and Zod, provider-backed, and
built around `rigd` as the runtime authority. The rewrite removes Effect TS.

The September 9 rewrite is in progress on `feat/typescript-runtime`. Isolated
integration and milestone reviews are recorded below; final battle testing,
the existing-Project rollout, and delivery in one PR remain pending.

## Product Model

Rig uses committed project config plus host-level machine config:

| Term | Meaning |
|---|---|
| Project | A repo or app managed by Rig. The configured Project identity is the canonical name used by `--project`. |
| Working copy Target | The current checkout on disk. The first release uses the name `local`. |
| Stable Target | A durable non-local deployment target. The first release uses the name `live`. |
| Preview | A generated target created from a Preview branch. CLI commands select it with `preview <branch>`. |
| Branch | A local Git branch used by CLI deploy, or a pushed branch received through the Rig remote. |
| Commit | The exact code state a Branch resolves to at deploy time. |
| Persistent storage | Runtime data that survives restarts and redeploys. |

`rigd` owns runtime mutation: lifecycle, deploy, inventory, health, logs,
receipts, port reservations, persistent runtime state, and provider
coordination.

## Command Shape

The rewrite's normal CLI surface includes:

```bash
rigd install
rigd status
rigd uninstall

rig init
rig list
rig status
rig doctor
rig config
rig activity
rig status --json

rig deploy live
rig deploy live main
rig deploy preview feature/login

rig up local
rig down live
rig restart preview feature/login
rig logs live
rig logs preview feature/login --follow
rig rename new-name --project old-name
rig repoint /path/to/repo --project my-project
```

Project-scoped commands infer the Project when run inside a Rig workspace, or
use `--project <name>` to select a Project known to `rigd`.

`rig deploy` is Branch/Commit based. Bare `rig` prints help successfully.
`--json` is scoped to status, lifecycle, and deploy results; it is not a global
output mode. `rig bump`, global `--log-level`, `--state-root`, generic `--config`,
provider profiles, and stub choices are absent from the normal CLI.
Rename and repoint require stopped Targets and validated identity/path ownership.

## Deploy Rules

- `rig deploy live` deploys the configured Production branch.
- `rig deploy live <branch>` is allowed only when `<branch>` is the configured
  Production branch.
- `rig deploy preview <branch>` deploys an explicit local Branch as a Preview.
- Preview deploys from the Production branch itself are rejected; create a
  Preview branch such as `preview/main` instead.
- `--no-up` materializes a Deployment without starting it.
- Same-Commit deploys are no-ops unless `--force` is used.

Git push deploys use the `git-remote-rig` helper:

```bash
git push rig main
git push rig feature/login
git push rig main:preview/main
```

The pushed destination Branch controls classification. The Production branch
updates the Stable Target; any other destination Branch creates or updates a
Preview.

Status probes process presence, configured health checks, installed tools, and
Persistent storage concurrently within a two-second total observation budget.
`healthy` requires a passing configured check; process presence alone is
`running`, unfinished observations are `unknown`, and CLI-only Targets can be
`ready`. Configured-only components remain `configured`. Stopped routes remain
visible. Up/down/restart use recorded deployment policy; doctor reports drift
against current config.

## Config Ownership

Project config owns portable Project intent, such as Project identity,
Production branch, Target names, commands, health paths, route shape, and
Preview naming policy.

Host config owns machine capability, such as local tool paths, base domains,
port ranges, runtime roots, auth tokens, daemon address, and installed provider
defaults.

`rigd` resolves both into a runtime plan before calling providers. Providers
must not read global path helpers or config files directly.

New Project documents use `rig.yaml`; new Host documents use
`$RIG_ROOT/config.yaml` (normally `~/.rig/config.yaml`). Existing `rig.json` and
`config.json` remain supported without a format warning. `.yml` is unsupported;
both supported filenames in one scope are an error. YAML accepts one document
with comments and rejects duplicate keys, tags, anchors, aliases, and merge keys.
Existing files are never automatically converted. `rig config` displays a
validated view and its source path without rewriting the document.

Only the `default` provider profile is supported. `stub` and `isolated-e2e`
profiles are rejected; isolation requires explicit test providers and `RIG_ROOT`.
Preserved legacy plans with unsupported profiles require explicit reconciliation
before lifecycle effects; retaining historical metadata does not select a real provider.
Caddy `reload.mode: command` requires an explicit nonblank `command`; manual and
disabled reload modes do not run a reload command.

User responses, diagnostic JSONL, Target stdout/stderr, and activity are separate.
Diagnostics rotate daily and retain 14 days by default. This retention policy
does not delete Project data, Target logs, or activity.

## Development

```bash
bun install
bun test
bun run build
```

Set `RIG_ROOT` for tests, CI, and agent runs that need isolated state.

For example, inspect source entrypoints without touching the installed Host:

```bash
export RIG_ROOT="$(mktemp -d /tmp/rig-dev.XXXXXX)"
bun run src/index.ts --help
bun run src/rigd.ts --help
```

Integration tests create their own isolated daemons and provider resources.
The build packages `rig`, `rigd`, and `git-remote-rig`; final compiled-binary
battle testing remains a release check. Existing Host upgrades require an explicit backed-up cutover;
normal commands fail closed on unadopted legacy runtime ownership.

## Module Map

| Module | Responsibility |
|---|---|
| `src/config` | Zod validation, YAML/JSON documents, safe edits, and pure Target resolution. |
| `src/runtime` and `src/domain` | Recorded policy, serialized operations, deployment recovery, and observed read models. |
| `src/daemon` | Authenticated localhost transport, daemon administration, and adapter composition. |
| `src/providers` and `src/adapters` | Process ownership, independent Git sources, artifacts, routes, and Host effects. |
| `src/cli` and `src/diagnostics` | Command grammar, human/structured output, and safe diagnostic evidence. |
| `src/migration` | Explicit legacy metadata preview/publication and verified ownership adoption. |

## Docs

- [Current product PRD](./docs/PRD.md)
- [Rig guide](./docs/rig-guide.md)
- [Architecture/design notes](./DESIGN.md)
- [State preservation policy](./docs/state-preservation-policy.md)
- [Rewrite execution and pending release checks](./plans/typescript-rewrite.md)
- [Independent milestone review evidence](./docs/reviews/2026-09-09-rewrite-milestones.md)
- [Legacy preservation and adoption](./docs/reviews/2026-09-09-legacy-migration.md)
