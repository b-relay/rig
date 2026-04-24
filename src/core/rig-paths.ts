import { homedir } from "node:os"
import { join } from "node:path"

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

export const rigVersionsRoot = (): string =>
  join(rigRoot(), "versions")

export const rigVersionHistoryPath = (name: string): string =>
  join(rigVersionsRoot(), `${name}.json`)

export const rigBinRoot = (): string =>
  join(rigRoot(), "bin")

export const rigBinPath = (name: string, env: string): string =>
  join(rigBinRoot(), env === "dev" ? `${name}-dev` : name)

export const rigCaddyRoot = (): string =>
  join(rigRoot(), "caddy")

export const rigCaddyfilePath = (): string =>
  join(rigCaddyRoot(), "Caddyfile")

export const rigLaunchdBackupRoot = (): string =>
  join(rigRoot(), "launchd")

export const rigIsolatedE2EStatePath = (): string =>
  join(rigRoot(), "isolated-e2e-process-manager.json")

export const rigIsolatedE2ELaunchdBackupRoot = (): string =>
  join(rigRoot(), "isolated-e2e-launchd-backups")
