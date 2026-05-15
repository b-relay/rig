# rig

Local Mac deployment manager.

`rig` runs, inspects, and deploys local projects on one computer. It is
repo-first, Effect v4 based, provider-backed, and built around `rigd` as the
runtime authority.

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

The intended normal CLI surface is:

```bash
rigd install
rigd status
rigd uninstall

rig init
rig list
rig status
rig doctor

rig deploy live
rig deploy live main
rig deploy preview
rig deploy preview feature/login

rig up local
rig down live
rig restart preview feature/login
rig logs live
rig logs preview feature/login --follow
```

Project-scoped commands infer the Project when run inside a Rig workspace, or
use `--project <name>` to select a Project known to `rigd`.

`rig deploy` is Branch/Commit based. `rig bump` is obsolete and should be
removed. Normal `rig` commands should not expose `--state-root`, `--config`,
provider profiles, package-script scaffolding, broad `--json` flags, or stub
provider choices.

## Deploy Rules

- `rig deploy live` deploys the configured Production branch.
- `rig deploy live <branch>` is allowed only when `<branch>` is the configured
  Production branch.
- `rig deploy preview` deploys the current Branch as a Preview.
- `rig deploy preview <branch>` deploys an explicit local Branch as a Preview.
- Preview deploys from the Production branch itself are rejected; create a
  Preview branch such as `preview/main` instead.
- `--no-up` materializes a Deployment without starting it.
- Same-Commit deploys are no-ops unless `--force` is used.

Git push deploys are also part of the model:

```bash
git push rig main
git push rig feature/login
git push rig main:preview/main
```

The pushed destination Branch controls classification. The Production branch
updates the Stable Target; any other destination Branch creates or updates a
Preview.

## Config Ownership

Project config owns portable Project intent, such as Project identity,
Production branch, Target names, commands, health paths, route shape, and
Preview naming policy.

Host config owns machine capability, such as local tool paths, base domains,
port ranges, runtime roots, auth tokens, daemon address, and installed provider
defaults.

`rigd` resolves both into a runtime plan before calling providers. Providers
must not read global path helpers or config files directly.

## Development

```bash
bun install
bun test
bun run build
```

Set `RIG_ROOT` for tests, CI, and agent runs that need isolated state.

## Docs

- [Current product PRD](./docs/PRD.md)
- [Rig guide](./docs/rig-guide.md)
- [Architecture/design notes](./DESIGN.md)
- [State preservation policy](./docs/state-preservation-policy.md)
- [Effect v4 notes](./docs/effect-v4-help-notes.md)
