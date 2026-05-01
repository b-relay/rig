# Rig State Preservation Policy

This document records the historical state decision for replacement cutover.
It is the policy for GitHub issue #51.

## Decision

Rig is non-destructive by default.

Current runtime state lives under `~/.rig`, or under `RIG_ROOT` for isolated
test, CI, and agent runs. Historical or pre-policy artifacts under those roots
must be preserved until a maintainer explicitly approves a narrower migration,
archive, or deletion action.

Do not migrate old state in place. Do not run broad cleanup commands such as
`rm -rf ~/.rig` as part of normal replacement work. Destructive cleanup needs a
separate issue, an inventory, a dry-run summary, a backup, and explicit
maintainer approval.

## Inventory

| Artifact | Location | Policy |
|---|---|---|
| Home config | `~/.rig/config.json` or `<RIG_ROOT>/config.json` | Preserve. This is the source for default provider profile, Caddy settings, deploy defaults, and control-plane config. Archive before manual rewrites. |
| Project registry | `~/.rig/registry.json` or `<RIG_ROOT>/registry.json` | Preserve. It records known projects and should not be deleted unless a replacement inventory exists. |
| Runtime state | `~/.rig/runtime/runtime.json`, `~/.rig/runtime/rigd-state.json`, or matching files under `RIG_ROOT` | Preserve. `rigd` can rebuild some current read models from bounded evidence, but historical runtime records may be the only rollback evidence. |
| Workspaces | `~/.rig/workspaces/**` or `<RIG_ROOT>/workspaces/**` | Archive before deletion. Generated workspaces may be reproducible from source refs, but do not assume every local working copy can be recreated. |
| Logs | `~/.rig/logs/**` or `<RIG_ROOT>/logs/**` | Archive. Logs are diagnostic and audit evidence for cutover failures. |
| Rig-managed proxy file | `~/.rig/proxy/Caddyfile`, configured Caddyfile paths, and `*.backup-*` files | Preserve. Compare before manual edits. Rig may update only marked managed blocks. |
| System or user Caddyfile | For example `/usr/local/etc/Caddyfile`, or the configured home Caddyfile path | Preserve. Never delete non-rig site blocks. Machine-specific imports and secrets stay outside generated rig output. |
| launchd plists | `~/Library/LaunchAgents/com.b-relay.rig.*.plist` | Preserve until provider cleanup removes known labels. Archive plist contents before manual deletion. |
| Generated bin files | `~/.rig/bin/**` or `<RIG_ROOT>/bin/**` | Archive or regenerate only after confirming source refs and build commands. Delete only after confirming no shell workflow depends on the file. |
| Project config | `rig.json` and `rig.json.backup-*.json` | Preserve in the project repo. Config writes go through `rig config`/`rigd`, and backups remain rollback handles until the maintainer confirms cleanup. |
| Old build artifacts or binaries | Git history, saved release artifacts, or local build outputs | Preserve until real-project replacement validation is complete. Rollback depends on being able to run the previous implementation against preserved state. |

## Allowed Now

- Document the policy and keep it linked from cutover docs.
- Use `RIG_ROOT="$(mktemp -d)"` for tests, CI, Caddy E2E, Pantry dry runs, and
  agent validation.
- Create archive copies when a maintainer asks for them.
- Update rig-managed Caddy blocks through provider paths.
- Remove temporary isolated test roots created during the same validation run.

## Requires Explicit Approval

- Deleting or replacing `~/.rig`.
- Deleting `~/.rig/runtime`, `~/.rig/workspaces`, `~/.rig/logs`, or
  `~/.rig/proxy`.
- Removing launchd plists manually.
- Editing or deleting a Caddyfile outside rig-managed marked blocks.
- Deleting Caddyfile backups, config backups, runtime records, logs, or old
  binary artifacts.
- Migrating historical state into a new shape.

## Rollback Implications

Replacement rollback assumes preserved state and a runnable previous build.

If replacement fails on a real project:

1. Stop current rig-managed processes through the provider path when possible.
2. Restore the previous `rig` binary from git history or a saved artifact.
3. Point the restored binary at the preserved historical state.
4. Avoid in-place migration while debugging the failure.
5. Restore `rig.json` from the reported `rig.json.backup-*.json` file if a
   config edit failed.
6. Inspect `rigd` inventory/read models before deleting stale generated
   deployment state manually.

## Future Cleanup Procedure

Any future cleanup or migration must be handled as a separate issue with this
shape:

1. Produce a dry-run inventory of exact paths and launchd/Caddy labels.
2. Classify each artifact as preserve, migrate, archive, regenerate, or delete.
3. Record rollback impact before any destructive action.
4. Create a backup or archive for every non-regenerable artifact.
5. Get explicit maintainer approval for the exact action.
6. Perform the smallest approved action.
7. Verify `rig status`, `rig doctor`, Caddy routing, launchd state, and project
   rollback handles after cleanup.
