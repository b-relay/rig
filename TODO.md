# TODO

## Post-Cutover Follow-Ups

### Real Provider Validation

- #48 Keep isolated real-Caddy reachability coverage green.
- #49 Keep the Pantry dry run green with isolated bin root, Caddyfile,
  workspace, data, log, and rig state paths.
- #51 Keep the state preservation policy current before any historical runtime
  state cleanup.

### Hosted Control Plane

- #52 Add the real hosted transport implementation behind `RigHostedControlPlaneTransport`.
- #52 Store machine identity and pairing tokens in home config or another rigd-owned local secret store.
- #52 Add integration coverage for reconnect, retry, and envelope delivery failure behavior.

### Product Polish

- #50 Expand init ergonomics only where real project setup shows repeated friction.
- Decide whether `rig bump` remains the final command name.
- Decide whether `rig forget` is needed.
- #53 Expand doctor real-provider diagnostics.
