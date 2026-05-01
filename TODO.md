# TODO

## Post-Cutover Follow-Ups

### Real Provider Validation

- #48 Keep isolated real-Caddy reachability coverage green.
- #49 Run a Pantry dry run with isolated bin root, Caddyfile, launchd home, and
  rig state root.
- #51 Document the exact state preservation or migration decision before deleting
  historical runtime state.

### Hosted Control Plane

- #52 Add the real hosted transport implementation behind `RigHostedControlPlaneTransport`.
- #52 Store machine identity and pairing tokens in home config or another rigd-owned local secret store.
- #52 Add integration coverage for reconnect, retry, and envelope delivery failure behavior.

### Product Polish

- #50 Expand init ergonomics only where real project setup shows repeated friction.
- Decide whether `rig bump` remains the final command name.
- Decide whether `rig forget` is needed.
- #53 Expand doctor real-provider diagnostics.
