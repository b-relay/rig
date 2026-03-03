import { join } from "node:path"
import { homedir } from "node:os"
import { copyFile, mkdir } from "node:fs/promises"
import { Effect, Layer } from "effect"

import {
  ReverseProxy,
  type ProxyChange,
  type ProxyDiff,
  type ProxyEntry,
  type ReverseProxy as ReverseProxyService,
} from "../interfaces/reverse-proxy.js"
import { ProxyError } from "../schema/errors.js"

// ── Marker format: # [rig:<name>:<env>] ─────────────────────────────────────
// Each rig-managed block starts with a marker comment and ends at the closing }
// of the Caddy site block that follows it.

const MARKER_RE = /^# \[rig:([^:]+):(dev|prod)\]\s*$/

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

// ── Block parsing ───────────────────────────────────────────────────────────

interface ParsedBlock {
  readonly entry: ProxyEntry
  /** Start line index (inclusive, 0-based) of the marker comment */
  readonly startLine: number
  /** End line index (inclusive, 0-based) of the closing } */
  readonly endLine: number
}

/**
 * Parse all rig-managed blocks from Caddyfile text.
 *
 * A rig block is:
 *   # [rig:<name>:<env>]
 *   <domain> {
 *     reverse_proxy http://127.0.0.1:<port>
 *     ...
 *   }
 *
 * We extract name, env from the marker and domain, port from the block body.
 * The `upstream` field is set to the service name from the marker (we don't
 * have the service name in the Caddyfile itself, so we use a convention:
 * upstream = name, since deploy is the one that knows the actual service).
 */
const parseBlocks = (text: string): ParsedBlock[] => {
  const lines = text.split("\n")
  const blocks: ParsedBlock[] = []

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(MARKER_RE)
    if (!match) continue

    const name = match[1]
    const env = match[2] as "dev" | "prod"
    const startLine = i

    // Next non-empty line should be `<domain> {`
    let domainLine = i + 1
    while (domainLine < lines.length && lines[domainLine].trim() === "") {
      domainLine++
    }

    if (domainLine >= lines.length) continue

    const domainMatch = lines[domainLine].match(/^\s*(\S+)\s*\{/)
    if (!domainMatch) continue
    const domain = domainMatch[1]

    // Find port from reverse_proxy directive
    let port = 0
    let braceDepth = 1
    let endLine = domainLine

    for (let j = domainLine + 1; j < lines.length && braceDepth > 0; j++) {
      const trimmed = lines[j].trim()
      if (trimmed.includes("{")) braceDepth++
      if (trimmed.includes("}")) braceDepth--

      const proxyMatch = trimmed.match(/^reverse_proxy\s+https?:\/\/127\.0\.0\.1:(\d+)/)
      if (proxyMatch) {
        port = Number.parseInt(proxyMatch[1], 10)
      }

      if (braceDepth === 0) {
        endLine = j
      }
    }

    if (port === 0) continue // couldn't parse — skip silently

    blocks.push({
      entry: { name, env, domain, upstream: name, port },
      startLine,
      endLine,
    })

    // Skip past this block
    i = endLine
  }

  return blocks
}

// ── Block rendering ─────────────────────────────────────────────────────────

const renderBlock = (entry: ProxyEntry): string =>
  [
    `# [rig:${entry.name}:${entry.env}]`,
    `${entry.domain} {`,
    `\treverse_proxy http://127.0.0.1:${entry.port}`,
    `\timport cloudflare`,
    `\timport backend_errors`,
    `}`,
  ].join("\n")

// ── CaddyProxy implementation ───────────────────────────────────────────────

export class CaddyProxy implements ReverseProxyService {
  readonly caddyfilePath: string

  constructor(caddyfilePath?: string) {
    this.caddyfilePath = caddyfilePath ?? join(homedir(), ".rig", "caddy", "Caddyfile")
  }

  read(): Effect.Effect<readonly ProxyEntry[], ProxyError> {
    return this.readFile().pipe(
      Effect.map((text) => parseBlocks(text).map((b) => b.entry)),
    )
  }

  add(entry: ProxyEntry): Effect.Effect<ProxyChange, ProxyError> {
    return Effect.gen(this, function* () {
      const text = yield* this.readFile()
      const existing = parseBlocks(text)
      const key = `${entry.name}:${entry.env}`

      if (existing.some((b) => `${b.entry.name}:${b.entry.env}` === key)) {
        return yield* Effect.fail(
          new ProxyError(
            "add",
            `Proxy entry '${entry.name}' (${entry.env}) already exists in Caddyfile.`,
            "Use update to modify an existing entry.",
          ),
        )
      }

      const block = renderBlock(entry)
      const newText = text.trimEnd() === "" ? block + "\n" : text.trimEnd() + "\n\n" + block + "\n"
      yield* this.writeFile(newText)

      return { type: "added" as const, entry }
    })
  }

  update(entry: ProxyEntry): Effect.Effect<ProxyChange, ProxyError> {
    return Effect.gen(this, function* () {
      const text = yield* this.readFile()
      const lines = text.split("\n")
      const existing = parseBlocks(text)
      const key = `${entry.name}:${entry.env}`
      const target = existing.find((b) => `${b.entry.name}:${b.entry.env}` === key)

      if (!target) {
        return yield* Effect.fail(
          new ProxyError(
            "update",
            `Proxy entry '${entry.name}' (${entry.env}) not found in Caddyfile.`,
            "Use add to create a new entry first.",
          ),
        )
      }

      const before = lines.slice(0, target.startLine)
      const after = lines.slice(target.endLine + 1)
      const block = renderBlock(entry)

      const newText = [...before, block, ...after].join("\n")
      yield* this.writeFile(newText)

      return { type: "updated" as const, entry }
    })
  }

  remove(name: string, env: string): Effect.Effect<ProxyChange, ProxyError> {
    return Effect.gen(this, function* () {
      const text = yield* this.readFile()
      const lines = text.split("\n")
      const existing = parseBlocks(text)
      const key = `${name}:${env}`
      const target = existing.find((b) => `${b.entry.name}:${b.entry.env}` === key)

      if (!target) {
        return yield* Effect.fail(
          new ProxyError(
            "remove",
            `Proxy entry '${name}' (${env}) not found in Caddyfile.`,
            "Nothing to remove.",
          ),
        )
      }

      // Remove block lines, and any trailing blank line
      let endIdx = target.endLine + 1
      while (endIdx < lines.length && lines[endIdx].trim() === "") {
        endIdx++
        break // remove at most one trailing blank line
      }

      const before = lines.slice(0, target.startLine)
      const after = lines.slice(endIdx)
      const newText = [...before, ...after].join("\n")
      yield* this.writeFile(newText)

      return { type: "removed" as const, entry: target.entry }
    })
  }

  diff(): Effect.Effect<ProxyDiff, ProxyError> {
    // Stub: diff will be fleshed out when deploy orchestration needs it
    return this.read().pipe(
      Effect.map((entries) => ({
        changes: [] as readonly ProxyChange[],
        unchanged: entries,
      })),
    )
  }

  backup(): Effect.Effect<string, ProxyError> {
    return Effect.tryPromise({
      try: async () => {
        const ts = new Date().toISOString().replace(/[:.]/g, "-")
        const backupPath = `${this.caddyfilePath}.backup-${ts}`
        await copyFile(this.caddyfilePath, backupPath)
        return backupPath
      },
      catch: (cause) =>
        new ProxyError(
          "backup",
          `Failed to backup Caddyfile: ${causeMessage(cause)}`,
          `Ensure ${this.caddyfilePath} exists and is readable.`,
        ),
    })
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private readFile(): Effect.Effect<string, ProxyError> {
    return Effect.tryPromise({
      try: async () => {
        const file = Bun.file(this.caddyfilePath)
        const exists = await file.exists()
        if (!exists) {
          // If the Caddyfile doesn't exist yet, treat as empty
          return ""
        }
        return await file.text()
      },
      catch: (cause) =>
        new ProxyError(
          "read",
          `Failed to read Caddyfile at ${this.caddyfilePath}: ${causeMessage(cause)}`,
          "Ensure the Caddyfile path is valid and readable.",
        ),
    })
  }

  private writeFile(content: string): Effect.Effect<void, ProxyError> {
    return Effect.tryPromise({
      try: async () => {
        // Ensure parent directory exists
        const dir = this.caddyfilePath.substring(0, this.caddyfilePath.lastIndexOf("/"))
        await mkdir(dir, { recursive: true })
        await Bun.write(this.caddyfilePath, content)
      },
      catch: (cause) =>
        new ProxyError(
          "add",
          `Failed to write Caddyfile at ${this.caddyfilePath}: ${causeMessage(cause)}`,
          "Ensure the Caddyfile path is writable.",
        ),
    })
  }
}

export const CaddyProxyLive = Layer.succeed(ReverseProxy, new CaddyProxy())
