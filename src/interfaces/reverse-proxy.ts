import { Context, Effect } from "effect-v3"
import type { ProxyError } from "../schema/errors.js"

export interface ProxyEntry {
  readonly name: string
  readonly env: "dev" | "prod"
  readonly domain: string
  readonly upstream: string
  readonly port: number
}

export interface ProxyChange {
  readonly type: "added" | "updated" | "removed"
  readonly entry: ProxyEntry
}

export interface ProxyDiff {
  readonly changes: readonly ProxyChange[]
  readonly unchanged: readonly ProxyEntry[]
}

export interface ReverseProxy {
  readonly read: () => Effect.Effect<readonly ProxyEntry[], ProxyError>
  readonly add: (entry: ProxyEntry) => Effect.Effect<ProxyChange, ProxyError>
  readonly update: (entry: ProxyEntry) => Effect.Effect<ProxyChange, ProxyError>
  readonly remove: (name: string, env: string) => Effect.Effect<ProxyChange, ProxyError>
  readonly diff: () => Effect.Effect<ProxyDiff, ProxyError>
  readonly backup: () => Effect.Effect<string, ProxyError>
}

export const ReverseProxy = Context.GenericTag<ReverseProxy>("ReverseProxy")
