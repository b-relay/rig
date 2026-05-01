import type { RigProviderPlugin } from "../provider-contracts.js"

export const stubTunnelProvider = {
  id: "stub-tunnel",
  family: "tunnel",
  source: "first-party",
  displayName: "Stub Tunnel",
  capabilities: ["tunnel-contract-test"],
} satisfies RigProviderPlugin
