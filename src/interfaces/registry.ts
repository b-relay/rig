import { Context, Effect } from "effect"
import type { RegistryError } from "../schema/errors.js"

export interface RegistryEntry {
  readonly name: string
  readonly repoPath: string
  readonly registeredAt: Date
}

export interface Registry {
  readonly register: (
    name: string,
    repoPath: string
  ) => Effect.Effect<void, RegistryError>
  readonly unregister: (
    name: string
  ) => Effect.Effect<void, RegistryError>
  readonly resolve: (
    name: string
  ) => Effect.Effect<string, RegistryError>
  readonly list: () => Effect.Effect<readonly RegistryEntry[], RegistryError>
}

export const Registry = Context.GenericTag<Registry>("Registry")
