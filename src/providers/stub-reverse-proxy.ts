import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Layer } from "effect"

import { ReverseProxy, type ProxyChange, type ProxyDiff, type ProxyEntry, type ReverseProxy as ReverseProxyService } from "../interfaces/reverse-proxy.js"
import { ProxyError } from "../schema/errors.js"

const keyFor = (entry: Pick<ProxyEntry, "name" | "env">): string => `${entry.name}:${entry.env}`

export class StubReverseProxy implements ReverseProxyService {
  private readonly entries = new Map<string, ProxyEntry>()

  read(): Effect.Effect<readonly ProxyEntry[], ProxyError> {
    return Effect.succeed(Array.from(this.entries.values()))
  }

  add(entry: ProxyEntry): Effect.Effect<ProxyChange, ProxyError> {
    const key = keyFor(entry)
    if (this.entries.has(key)) {
      return Effect.fail(
        new ProxyError("add", `Proxy entry '${entry.name}' (${entry.env}) already exists.`, "Use update instead."),
      )
    }

    this.entries.set(key, entry)
    return Effect.succeed({
      type: "added",
      entry,
    })
  }

  update(entry: ProxyEntry): Effect.Effect<ProxyChange, ProxyError> {
    const key = keyFor(entry)
    if (!this.entries.has(key)) {
      return Effect.fail(
        new ProxyError("update", `Proxy entry '${entry.name}' (${entry.env}) does not exist.`, "Use add first."),
      )
    }

    this.entries.set(key, entry)
    return Effect.succeed({
      type: "updated",
      entry,
    })
  }

  remove(name: string, env: string): Effect.Effect<ProxyChange, ProxyError> {
    const key = `${name}:${env}`
    const existing = this.entries.get(key)

    if (!existing) {
      return Effect.fail(
        new ProxyError("remove", `Proxy entry '${name}' (${env}) does not exist.`, "Nothing to remove."),
      )
    }

    this.entries.delete(key)
    return Effect.succeed({
      type: "removed",
      entry: existing,
    })
  }

  diff(): Effect.Effect<ProxyDiff, ProxyError> {
    return Effect.succeed({
      changes: [],
      unchanged: Array.from(this.entries.values()),
    })
  }

  backup(): Effect.Effect<string, ProxyError> {
    return Effect.succeed(join(tmpdir(), `rig-proxy-backup-${Date.now()}.json`))
  }
}

export const StubReverseProxyLive = Layer.succeed(ReverseProxy, new StubReverseProxy())
