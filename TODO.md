# TODO

## Rig Follow-Ups

### Hosted Control Plane

- Add the real hosted transport implementation behind `V2HostedControlPlaneTransport`.
- Store machine identity and pairing tokens in home config or another rigd-owned local secret store.
- Add integration coverage for reconnect, retry, and envelope delivery failure behavior.

### Cutover Polish

- Keep v2 state namespaces such as `~/.rig-v2`, launchd labels, and Caddy markers
  until an explicit migration plan moves or aliases that runtime state.
- Expand init ergonomics only where real project setup shows repeated friction.
