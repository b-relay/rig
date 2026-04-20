import { homedir } from "node:os"
import { join } from "node:path"

export const RIG_V2_NAMESPACE = "rig.v2"
export const RIG_V2_LAUNCHD_LABEL_PREFIX = "com.b-relay.rig2"
export const RIG_V2_PROXY_NAMESPACE = "rig2"

const configuredRigV2Root = (): string | null => {
  const raw = process.env.RIG_V2_ROOT?.trim()
  return raw && raw.length > 0 ? raw : null
}

export const rigV2Root = (): string =>
  configuredRigV2Root() ?? join(homedir(), ".rig-v2")

export const rigV2RegistryPath = (): string =>
  join(rigV2Root(), "registry.json")

export const rigV2WorkspacesRoot = (): string =>
  join(rigV2Root(), "workspaces")

export const rigV2LogsRoot = (): string =>
  join(rigV2Root(), "logs")

export const rigV2RuntimeRoot = (): string =>
  join(rigV2Root(), "runtime")

export const rigV2RuntimeStatePath = (): string =>
  join(rigV2RuntimeRoot(), "runtime.json")

export const rigV2ProxyRoot = (): string =>
  join(rigV2Root(), "proxy")

export const rigV2LaunchdBackupRoot = (): string =>
  join(rigV2Root(), "launchd")

export const rigV2ProjectNamespace = (name: string): string =>
  `${RIG_V2_NAMESPACE}.${name}`

export const rigV2LaunchdLabel = (name: string, lane: string): string =>
  `${RIG_V2_LAUNCHD_LABEL_PREFIX}.${name}.${lane}`

export const rigV2ProjectWorkspaceRoot = (name: string): string =>
  join(rigV2WorkspacesRoot(), name)

export const rigV2ProjectLogRoot = (name: string): string =>
  join(rigV2LogsRoot(), name)
