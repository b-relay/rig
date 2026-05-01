import { dirname, join } from "node:path"
import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import {
  isPlatformNotFound,
  platformCopyFile,
  platformExists,
  platformMakeDirectory,
  platformReadFileString,
  platformWriteFileString,
} from "../effect-platform.js"
import { V2RuntimeError } from "../errors.js"
import { rigV2ProxyRoot } from "../paths.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
  V2RuntimeProxyConfig,
} from "../provider-contracts.js"

export interface V2CaddyCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type V2CaddyCommandRunner = (args: readonly string[]) => Promise<V2CaddyCommandResult>

export interface V2CaddyProxyRouterOptions {
  readonly caddyfile?: string
  readonly caddyfilePath?: string
  readonly extraConfig?: readonly string[]
  readonly runCommand?: V2CaddyCommandRunner
  readonly reload?: {
    readonly mode: "manual" | "command" | "disabled"
    readonly command?: string
  }
}

export interface V2CaddyProxyRouterAdapter {
  readonly upsert: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly proxy: V2RuntimeProxyConfig
    },
    selected: V2ProviderPluginForFamily<"proxy-router">,
  ) => Effect.Effect<string, V2RuntimeError>
  readonly remove: (
    input: {
      readonly deployment: V2DeploymentRecord
      readonly proxy: V2RuntimeProxyConfig
    },
    selected: V2ProviderPluginForFamily<"proxy-router">,
  ) => Effect.Effect<string, V2RuntimeError>
}

interface V2CaddyRoute {
  readonly project: string
  readonly deployment: string
  readonly upstream: string
  readonly domain: string
  readonly port: number
}

interface V2ParsedCaddyBlock {
  readonly route: V2CaddyRoute
  readonly startLine: number
  readonly endLine: number
}

interface V2CaddySiteBlock {
  readonly route?: V2CaddyRoute
  readonly domain: string
  readonly port: number
  readonly startLine: number
  readonly endLine: number
}

export const caddyProxyRouterProvider = {
  id: "caddy",
  family: "proxy-router",
  source: "first-party",
  displayName: "Caddy",
  capabilities: ["local-reverse-proxy", "tls-termination"],
} satisfies V2ProviderPlugin

const V2_CADDY_MARKER_RE = /^# \[rig2:([^:]+):([^:]+):([^\]]+)\]\s*$/
const V1_CADDY_MARKER_RE = /^# \[rig:([^:]+):(dev|prod)(?::([^\]]+))?\]\s*$/

const routeKey = (route: Pick<V2CaddyRoute, "project" | "deployment" | "upstream">): string =>
  `${route.project}:${route.deployment}:${route.upstream}`

const parseCaddySiteBlocks = (text: string): readonly V2CaddySiteBlock[] => {
  const lines = text.split("\n")
  const blocks: V2CaddySiteBlock[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const marker = line.match(V2_CADDY_MARKER_RE)
    const v1Marker = line.match(V1_CADDY_MARKER_RE)
    const markerLine = marker || v1Marker ? index : undefined
    const domainLine = markerLine === undefined
      ? index
      : (() => {
        let candidate = markerLine + 1
        while (candidate < lines.length && lines[candidate]?.trim() === "") {
          candidate += 1
        }
        return candidate
      })()

    const domainMatch = lines[domainLine]?.match(/^\s*(\S+)\s*\{/)
    if (!domainMatch || domainMatch[1].startsWith("(")) {
      continue
    }

    const domain = domainMatch[1]
    let port = 0
    let braceDepth = 1
    let endLine = domainLine

    for (let scan = domainLine + 1; scan < lines.length && braceDepth > 0; scan += 1) {
      const trimmed = lines[scan]?.trim() ?? ""
      if (trimmed.endsWith("{")) {
        braceDepth += 1
      }
      if (trimmed === "}") {
        braceDepth -= 1
      }

      const proxyMatch = trimmed.match(/^reverse_proxy\s+https?:\/\/127\.0\.0\.1:(\d+)/)
      if (proxyMatch) {
        port = Number.parseInt(proxyMatch[1], 10)
      }

      if (braceDepth === 0) {
        endLine = scan
      }
    }

    if (port === 0) {
      continue
    }

    let startLine = markerLine ?? domainLine
    if (markerLine === undefined && domainLine > 0 && lines[domainLine - 1]?.trim().startsWith("#")) {
      startLine = domainLine - 1
    }

    const route = marker
      ? {
        project: marker[1],
        deployment: marker[2],
        upstream: marker[3],
        domain,
        port,
      }
      : v1Marker
        ? {
          project: v1Marker[1],
          deployment: v1Marker[2] === "prod" ? "live" : "local",
          upstream: v1Marker[3] ?? "web",
          domain,
          port,
        }
        : undefined

    blocks.push({
      ...(route ? { route } : {}),
      domain,
      port,
      startLine,
      endLine,
    })
    index = Math.max(index, endLine)
  }

  return blocks
}

const parseV2CaddyBlocks = (text: string): readonly V2ParsedCaddyBlock[] =>
  parseCaddySiteBlocks(text).flatMap((block) =>
    block.route && block.startLine >= 0
      ? [{ route: block.route, startLine: block.startLine, endLine: block.endLine }]
      : [],
  )

const renderV2CaddyBlock = (
  route: V2CaddyRoute,
  extraConfig: readonly string[] = [],
): string =>
  [
    `# [rig2:${route.project}:${route.deployment}:${route.upstream}]`,
    `${route.domain} {`,
    `\treverse_proxy http://127.0.0.1:${route.port}`,
    ...extraConfig.map((line) => `\t${line}`),
    `}`,
  ].join("\n")

const readTextIfExists = (path: string): Effect.Effect<string, unknown> =>
  platformReadFileString(path).pipe(
    Effect.catch((cause) => isPlatformNotFound(cause) ? Effect.succeed("") : Effect.fail(cause)),
  )

const backupIfExists = (path: string): Effect.Effect<void, unknown> =>
  platformExists(path).pipe(
    Effect.flatMap((exists) =>
      exists
        ? platformCopyFile(path, `${path}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`)
        : Effect.void
    ),
  )

const writeText = (path: string, text: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    yield* platformMakeDirectory(dirname(path))
    yield* platformWriteFileString(path, text)
  })

const deploymentDomain = (
  deployment: V2DeploymentRecord,
  provider: V2ProviderPlugin,
): Effect.Effect<string, V2RuntimeError> => {
  const domain = deployment.resolved.v1Config.domain
  if (typeof domain === "string" && domain.trim().length > 0) {
    return Effect.succeed(domain)
  }

  return Effect.fail(
    new V2RuntimeError(
      `Unable to route deployment '${deployment.name}' without a domain.`,
      "Set a project domain or lane domain before enabling proxy routing.",
      {
        providerId: provider.id,
        project: deployment.project,
        deployment: deployment.name,
      },
    ),
  )
}

const upstreamPort = (
  deployment: V2DeploymentRecord,
  upstream: string,
  provider: V2ProviderPlugin,
): Effect.Effect<number, V2RuntimeError> => {
  const service = deployment.resolved.environment.services.find((candidate) => candidate.name === upstream)
  if (service && service.type === "server" && "port" in service && typeof service.port === "number") {
    return Effect.succeed(service.port)
  }

  return Effect.fail(
    new V2RuntimeError(
      `Unable to route upstream '${upstream}' for deployment '${deployment.name}'.`,
      "Proxy upstream must reference a managed component with a concrete port.",
      {
        providerId: provider.id,
        project: deployment.project,
        deployment: deployment.name,
        upstream,
      },
    ),
  )
}

const runtimeError = (
  message: string,
  hint: string,
  details?: Readonly<Record<string, unknown>>,
) => (cause: unknown) =>
  new V2RuntimeError(
    message,
    hint,
    {
      cause: cause instanceof Error ? cause.message : String(cause),
      ...(details ?? {}),
    },
  )

export const createCaddyProxyRouterAdapter = (
  options: V2CaddyProxyRouterOptions | undefined,
  defaultCommandRunner: V2CaddyCommandRunner,
): V2CaddyProxyRouterAdapter => {
  const caddyfilePath = options?.caddyfilePath ?? options?.caddyfile ?? join(rigV2ProxyRoot(), "Caddyfile")
  const extraConfig = options?.extraConfig ?? []
  const reloadConfig = options?.reload ?? { mode: "manual" as const }
  const runReload = options?.runCommand ?? defaultCommandRunner

  const reloadCaddyAfterWrite = (
    selected: V2ProviderPluginForFamily<"proxy-router">,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    if (reloadConfig.mode !== "command") {
      return Promise.resolve()
    }
    const command = reloadConfig.command?.trim()
    if (!command) {
      return Promise.reject(new V2RuntimeError(
        "Unable to reload Caddy because no reload command is configured.",
        "Set providers.caddy.reload.command or use manual reload mode.",
        {
          providerId: selected.id,
          caddyfilePath,
          ...details,
        },
      ))
    }

    return runReload(["sh", "-lc", command]).then((result) => {
      if (result.exitCode !== 0) {
        throw new V2RuntimeError(
          "Caddy reload command failed.",
          "Inspect the configured Caddy reload command and retry after fixing Caddy.",
          {
            providerId: selected.id,
            caddyfilePath,
            command,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            ...details,
          },
        )
      }
    })
  }

  const upsert = (input: {
    readonly deployment: V2DeploymentRecord
    readonly proxy: V2RuntimeProxyConfig
  }, selected: V2ProviderPluginForFamily<"proxy-router">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
      const domain = yield* deploymentDomain(input.deployment, selected)
      const port = yield* upstreamPort(input.deployment, input.proxy.upstream, selected)
      const route: V2CaddyRoute = {
        project: input.deployment.project,
        deployment: input.deployment.name,
        upstream: input.proxy.upstream,
        domain,
        port,
      }

      yield* Effect.gen(function* () {
        const text = yield* readTextIfExists(caddyfilePath)
        const lines = text.split("\n")
        const existing = parseCaddySiteBlocks(text)
        const target =
          existing.find((block) => block.route && routeKey(block.route) === routeKey(route)) ??
          existing.find((block) => block.domain === route.domain)
        const block = renderV2CaddyBlock(route, extraConfig)
        const next = target
          ? [
            ...lines.slice(0, target.startLine),
            block,
            ...lines.slice(target.endLine + 1),
          ].join("\n")
          : text.trimEnd() === ""
            ? `${block}\n`
            : `${text.trimEnd()}\n\n${block}\n`

        yield* backupIfExists(caddyfilePath)
        yield* writeText(caddyfilePath, next)
        yield* Effect.tryPromise({
          try: () => reloadCaddyAfterWrite(selected, {
            project: input.deployment.project,
            deployment: input.deployment.name,
            upstream: input.proxy.upstream,
            domain,
            port,
          }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.mapError(runtimeError(
          `Unable to upsert Caddy route for deployment '${input.deployment.name}'.`,
          "Ensure the v2 Caddyfile path is writable and retry proxy routing.",
          {
            providerId: selected.id,
            caddyfilePath,
            project: input.deployment.project,
            deployment: input.deployment.name,
            upstream: input.proxy.upstream,
            domain,
            port,
          },
        )),
      )

      return `${selected.family}:${selected.id}:upsert:${domain}:${input.proxy.upstream}:${port}`
    })

  const remove = (input: {
    readonly deployment: V2DeploymentRecord
    readonly proxy: V2RuntimeProxyConfig
  }, selected: V2ProviderPluginForFamily<"proxy-router">): Effect.Effect<string, V2RuntimeError> =>
    Effect.gen(function* () {
      const text = yield* readTextIfExists(caddyfilePath)
      const lines = text.split("\n")
      const key = routeKey({
        project: input.deployment.project,
        deployment: input.deployment.name,
        upstream: input.proxy.upstream,
      })
      const target = parseV2CaddyBlocks(text).find((block) => routeKey(block.route) === key)
      if (target) {
        let endLine = target.endLine + 1
        if (endLine < lines.length && lines[endLine]?.trim() === "") {
          endLine += 1
        }
        const next = [
          ...lines.slice(0, target.startLine),
          ...lines.slice(endLine),
        ].join("\n")
        yield* backupIfExists(caddyfilePath)
        yield* writeText(caddyfilePath, next)
        yield* Effect.tryPromise({
          try: () => reloadCaddyAfterWrite(selected, {
            project: input.deployment.project,
            deployment: input.deployment.name,
            upstream: input.proxy.upstream,
          }),
          catch: (cause) => cause,
        })
      }
      return `${selected.family}:${selected.id}:remove:${input.deployment.project}:${input.deployment.name}:${input.proxy.upstream}`
    }).pipe(
      Effect.mapError(runtimeError(
        `Unable to remove Caddy route for deployment '${input.deployment.name}'.`,
        "Ensure the v2 Caddyfile path is writable and retry proxy teardown.",
        {
          providerId: selected.id,
          caddyfilePath,
          project: input.deployment.project,
          deployment: input.deployment.name,
          upstream: input.proxy.upstream,
        },
      )),
    )

  return { upsert, remove }
}
