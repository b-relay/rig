# TODO

## Post-Cutover Follow-Ups

### CLI And Provider Cleanup

- #54 Keep PRD, docs, and implementation issues aligned with the Target,
  Branch/Commit deploy, daemon-admin, config ownership, and provider-context
  model.
- Remove `rig bump` from the normal CLI.
- Remove stale normal CLI exposure for `--state-root`, generic `--config`,
  provider-profile flags, package-script flags, broad `--json` flags, and stub
  provider choices.
- Keep project deletion out of implementation until a dedicated delete design
  exists.

### Real Provider Validation

- #48 Keep isolated real-Caddy reachability coverage green.
- #49 Keep the Pantry dry run green with isolated bin root, Caddyfile,
  workspace, data, log, and rig state paths.
- #51 Keep the state preservation policy current before any historical runtime
  state cleanup.

### Hosted Control Plane

- #52 Keep hosted transport disabled-by-default and covered for retry,
  reconnect, and delivery failure evidence.

### Product Polish

- #50 Keep init ergonomics tied to repeated real project setup friction.
- #53 Keep doctor real-provider diagnostics actionable as more failures are found.
