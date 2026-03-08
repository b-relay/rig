import { Effect } from "effect"

import { Logger } from "../interfaces/logger.js"
import type { Environment, Service, ServiceHooks, TopLevelHooks } from "../schema/config.js"
import { loadProjectConfig } from "./config.js"

const HOOK_ORDER = ["preStart", "postStart", "preStop", "postStop"] as const

type HookName = (typeof HOOK_ORDER)[number]
type HookSet = TopLevelHooks | ServiceHooks | undefined

const hookEntries = (hooks: HookSet): readonly [HookName, string][] =>
  HOOK_ORDER.flatMap((name) => {
    const value = hooks?.[name]
    if (typeof value !== "string" || value.trim().length === 0) {
      return []
    }

    return [[name, value] as const]
  })

const formatService = (service: Service): string[] => {
  const lines: string[] = [`    ${service.name} (${service.type})`]

  if (service.type === "server") {
    lines.push(`      Command: ${service.command}`)
    lines.push(`      Port: ${service.port}`)
    if (service.healthCheck) {
      lines.push(`      Health Check: ${service.healthCheck}`)
    }
    lines.push(`      Ready Timeout: ${service.readyTimeout}s`)
    if (service.dependsOn && service.dependsOn.length > 0) {
      lines.push(`      Depends On: ${service.dependsOn.join(", ")}`)
    }
  } else {
    lines.push(`      Entrypoint: ${service.entrypoint}`)
    if (service.build) {
      lines.push(`      Build: ${service.build}`)
    }
  }

  if (service.envFile) {
    lines.push(`      Env File: ${service.envFile}`)
  }

  const hooks = hookEntries(service.hooks)
  if (hooks.length > 0) {
    lines.push("      Hooks:")
    for (const [name, value] of hooks) {
      lines.push(`        ${name}: ${value}`)
    }
  }

  return lines
}

const formatEnvironment = (name: "dev" | "prod", env: Environment): string => {
  const lines: string[] = [`Environment: ${name}`]
  if (env.envFile) {
    lines.push(`  Env File: ${env.envFile}`)
  }
  if (env.proxy) {
    lines.push(`  Proxy: -> ${env.proxy.upstream}`)
  }

  lines.push("  Services:")
  for (const service of env.services) {
    lines.push(...formatService(service))
  }

  return lines.join("\n")
}

export const runConfigCommand = (name: string) =>
  Effect.gen(function* () {
    const logger = yield* Logger
    const loaded = yield* loadProjectConfig(name)

    const sections: string[] = []
    sections.push(
      [
        `Project: ${loaded.config.name}`,
        `Version: ${loaded.config.version}`,
        `Description: ${loaded.config.description ?? "(not set)"}`,
        `Domain: ${loaded.config.domain ?? "(not set)"}`,
        ...(loaded.config.mainBranch ? [`Main Branch: ${loaded.config.mainBranch}`] : []),
      ].join("\n"),
    )

    const projectHooks = hookEntries(loaded.config.hooks)
    if (projectHooks.length > 0) {
      sections.push(
        [
          "Hooks:",
          ...projectHooks.map(([hook, command]) => `  ${hook}: ${command}`),
        ].join("\n"),
      )
    }

    for (const envName of ["dev", "prod"] as const) {
      const envConfig = loaded.config.environments[envName]
      if (!envConfig) {
        continue
      }
      sections.push(formatEnvironment(envName, envConfig))
    }

    if (loaded.config.daemon) {
      sections.push(
        [
          "Daemon:",
          `  Enabled: ${loaded.config.daemon.enabled}`,
          `  Keep Alive: ${loaded.config.daemon.keepAlive}`,
        ].join("\n"),
      )
    }

    for (const section of sections) {
      yield* logger.info(section)
    }

    return 0
  })
