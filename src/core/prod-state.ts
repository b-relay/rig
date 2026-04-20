import { Effect } from "effect"

import { Workspace } from "../interfaces/workspace.js"
import { CliArgumentError } from "../schema/errors.js"
import { loadProjectConfigAtPath, type LoadedProjectConfig } from "./config.js"

export interface ActiveProdWorkspaceState {
  readonly version: string
  readonly workspacePath: string
  readonly loaded: LoadedProjectConfig
}

const noActiveProdDeploymentError = (
  command: "deploy" | "start" | "stop" | "restart" | "status" | "logs",
  name: string,
) =>
  new CliArgumentError(
    command,
    `Project '${name}' does not have an active prod deployment.`,
    `Use 'rig deploy ${name} prod --bump patch|minor|major' to create a new prod release, or 'rig deploy ${name} prod --version <semver>' to activate an existing one.`,
    { name, env: "prod" },
  )

const corruptedProdWorkspaceError = (
  command: "deploy" | "start" | "stop" | "restart" | "status" | "logs",
  name: string,
  workspaceVersion: string,
  configVersion: string,
  workspacePath: string,
) =>
  new CliArgumentError(
    command,
    `Active prod workspace '${workspaceVersion}' for project '${name}' is inconsistent.`,
    `Repair or redeploy prod version '${workspaceVersion}' before retrying. Workspace rig.json reports '${configVersion}'.`,
    {
      name,
      env: "prod",
      workspaceVersion,
      configVersion,
      workspacePath,
    },
  )

const resolveActiveProdWorkspaceRow = (name: string) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace
    const rows = yield* workspace.list(name)

    return rows.find((entry) => entry.env === "prod" && entry.active) ?? null
  })

export const validateActiveProdWorkspaceIfPresent = (
  command: "deploy" | "start" | "stop" | "restart" | "status" | "logs",
  name: string,
) =>
  Effect.gen(function* () {
    const active = yield* resolveActiveProdWorkspaceRow(name)
    if (!active || !active.version) {
      return null
    }

    const loaded = yield* loadProjectConfigAtPath(name, active.path)
    if (loaded.config.version !== active.version) {
      return yield* Effect.fail(
        corruptedProdWorkspaceError(command, name, active.version, loaded.config.version, active.path),
      )
    }

    return {
      version: active.version,
      workspacePath: active.path,
      loaded,
    } satisfies ActiveProdWorkspaceState
  })

export const requireActiveProdWorkspace = (
  command: "deploy" | "start" | "stop" | "restart" | "status" | "logs",
  name: string,
) =>
  Effect.gen(function* () {
    const active = yield* validateActiveProdWorkspaceIfPresent(command, name)
    if (!active) {
      return yield* Effect.fail(noActiveProdDeploymentError(command, name))
    }

    return active
  })
