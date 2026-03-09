import { Context, Effect } from "effect"
import type { WorkspaceError } from "../schema/errors.js"

export interface WorkspaceInfo {
  readonly name: string
  readonly env: "dev" | "prod"
  readonly version: string | null
  readonly path: string
  readonly active: boolean
}

export interface Workspace {
  readonly create: (
    name: string,
    env: "dev" | "prod",
    version: string,
    commitRef: string
  ) => Effect.Effect<string, WorkspaceError>
  readonly resolve: (
    name: string,
    env: "dev" | "prod",
    version?: string
  ) => Effect.Effect<string, WorkspaceError>
  readonly activate: (
    name: string,
    env: "dev" | "prod",
    version: string
  ) => Effect.Effect<string, WorkspaceError>
  readonly removeVersion: (
    name: string,
    env: "dev" | "prod",
    version: string
  ) => Effect.Effect<void, WorkspaceError>
  readonly renameVersion: (
    name: string,
    env: "dev" | "prod",
    fromVersion: string,
    toVersion: string
  ) => Effect.Effect<string, WorkspaceError>
  readonly sync: (
    name: string,
    env: "dev" | "prod"
  ) => Effect.Effect<void, WorkspaceError>
  readonly list: (
    name: string
  ) => Effect.Effect<readonly WorkspaceInfo[], WorkspaceError>
}

export const Workspace = Context.GenericTag<Workspace>("Workspace")
