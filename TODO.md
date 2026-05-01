# TODO

## Rig Follow-Ups

### Hosted Control Plane

- Add the real hosted transport implementation behind `RigHostedControlPlaneTransport`.
- Store machine identity and pairing tokens in home config or another rigd-owned local secret store.
- Add integration coverage for reconnect, retry, and envelope delivery failure behavior.

### Cutover Polish

- Keep rig state namespaces such as `~/.rig`, launchd labels, and Caddy markers
  until an explicit migration plan moves or aliases that runtime state.
- Expand init ergonomics only where real project setup shows repeated friction.
