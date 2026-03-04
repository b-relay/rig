import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Layer } from "effect"

import { ReverseProxy, type ProxyChange, type ProxyDiff, type ProxyEntry, type ReverseProxy as ReverseProxyService } from "../interfaces/reverse-proxy.js"
import { ProxyError } from "../schema/errors.js"

const keyFor = (entry: Pick<ProxyEntry, "name" | "env">): string => `${entry.name}:${entry.env}`

interface StubReverseProxyOptions {
  readonly initialEntries?: readonly ProxyEntry[]
  readonly readError?: ProxyError
  readonly addErrors?: Readonly<Record<string, ProxyError>>
  readonly updateErrors?: Readonly<Record<string, ProxyError>>
  readonly removeErrors?: Readonly<Record<string, ProxyError>>
  readonly diffError?: ProxyError
  readonly backupError?: ProxyError
}

export class StubReverseProxy implements ReverseProxyService {
  private readonly entries = new Map<string, ProxyEntry>()
  readonly readCalls: number[] = []
  readonly addCalls: ProxyEntry[] = []
  readonly updateCalls: ProxyEntry[] = []
  readonly removeCalls: Array<{ readonly name: string; readonly env: string }> = []
  readonly diffCalls: number[] = []
  readonly backupCalls: number[] = []

  constructor(private readonly options: StubReverseProxyOptions = {}) {
    for (const entry of options.initialEntries ?? []) {
      this.entries.set(keyFor(entry), entry)
    }
  }

  read(): Effect.Effect<readonly ProxyEntry[], ProxyError> {
    this.readCalls.push(this.readCalls.length + 1)
    if (this.options.readError) {
      return Effect.fail(this.options.readError)
    }

    return Effect.succeed(Array.from(this.entries.values()))
  }

  add(entry: ProxyEntry): Effect.Effect<ProxyChange, ProxyError> {
    this.addCalls.push(entry)
    const key = keyFor(entry)
    const failure = this.options.addErrors?.[key]
    if (failure) {
      return Effect.fail(failure)
    }

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
    this.updateCalls.push(entry)
    const key = keyFor(entry)
    const failure = this.options.updateErrors?.[key]
    if (failure) {
      return Effect.fail(failure)
    }

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
    this.removeCalls.push({ name, env })
    const key = `${name}:${env}`
    const failure = this.options.removeErrors?.[key]
    if (failure) {
      return Effect.fail(failure)
    }

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
    this.diffCalls.push(this.diffCalls.length + 1)
    if (this.options.diffError) {
      return Effect.fail(this.options.diffError)
    }

    return Effect.succeed({
      changes: [],
      unchanged: Array.from(this.entries.values()),
    })
  }

  backup(): Effect.Effect<string, ProxyError> {
    this.backupCalls.push(this.backupCalls.length + 1)
    if (this.options.backupError) {
      return Effect.fail(this.options.backupError)
    }

    return Effect.succeed(join(tmpdir(), `rig-proxy-backup-${Date.now()}.json`))
  }

  entriesSnapshot(): readonly ProxyEntry[] {
    return Array.from(this.entries.values())
  }
}

export const StubReverseProxyLive = Layer.succeed(ReverseProxy, new StubReverseProxy())
