import { homedir } from "node:os"
import { join } from "node:path"

export const RIG_NAMESPACE = "rig"
export const RIG_LAUNCHD_LABEL_PREFIX = "com.b-relay.rig"
export const RIG_PROXY_NAMESPACE = "rig"

const configuredRigRoot = (): string | null => {
  const raw = process.env.RIG_ROOT?.trim()
  return raw && raw.length > 0 ? raw : null
}

export const rigRoot = (): string =>
  configuredRigRoot() ?? join(homedir(), ".rig")

export const rigRegistryPath = (): string =>
  join(rigRoot(), "registry.json")

export const rigWorkspacesRoot = (): string =>
  join(rigRoot(), "workspaces")

export const rigLogsRoot = (): string =>
  join(rigRoot(), "logs")

export const rigRuntimeRoot = (): string =>
  join(rigRoot(), "runtime")

export const rigRuntimeStatePath = (): string =>
  join(rigRuntimeRoot(), "runtime.json")

export const rigProxyRoot = (): string =>
  join(rigRoot(), "proxy")

export const rigBinRoot = (): string =>
  join(rigRoot(), "bin")

export const rigBinPath = (name: string): string =>
  join(rigBinRoot(), name)

export const rigLaunchdBackupRoot = (): string =>
  join(rigRoot(), "launchd")

export const rigProjectNamespace = (name: string): string =>
  `${RIG_NAMESPACE}.${name}`

export const rigLaunchdLabel = (name: string, lane: string): string =>
  `${RIG_LAUNCHD_LABEL_PREFIX}.${name}.${lane}`

export const rigProjectWorkspaceRoot = (name: string): string =>
  join(rigWorkspacesRoot(), name)

export const rigProjectLogRoot = (name: string): string =>
  join(rigLogsRoot(), name)
