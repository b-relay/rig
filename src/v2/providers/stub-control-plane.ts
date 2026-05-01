import type { V2ProviderPlugin } from "../provider-contracts.js"

export const stubControlPlaneProvider = {
  id: "stub-control-plane",
  family: "control-plane-transport",
  source: "first-party",
  displayName: "Stub Control Plane",
  capabilities: ["localhost-contract-test"],
} satisfies V2ProviderPlugin
