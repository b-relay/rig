import type { RigProviderPlugin } from "../provider-contracts.js"

export const stubControlPlaneProvider = {
  id: "stub-control-plane",
  family: "control-plane-transport",
  source: "first-party",
  displayName: "Stub Control Plane",
  capabilities: ["localhost-contract-test"],
} satisfies RigProviderPlugin
