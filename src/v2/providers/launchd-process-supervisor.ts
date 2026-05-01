import { homedir } from "node:os"
import { join } from "node:path"
import { getuid } from "node:process"
import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import {
  platformMakeDirectory,
  platformRemove,
  platformWriteFileString,
} from "../effect-platform.js"
import { V2RuntimeError } from "../errors.js"
import { RIG_V2_LAUNCHD_LABEL_PREFIX } from "../paths.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
  V2RuntimeServiceConfig,
} from "../provider-contracts.js"
import type { V2ProcessSupervisorOperationResult } from "./process-supervisor.js"

export interface V2LaunchdCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type V2LaunchdCommandRunner = (args: readonly string[]) => Promise<V2LaunchdCommandResult>

export interface V2LaunchdProcessSupervisorOptions {
  readonly home?: string
  readonly runCommand?: V2LaunchdCommandRunner
}

interface V2LaunchdProcessSupervisorInput {
  readonly deployment: V2DeploymentRecord
  readonly service: V2RuntimeServiceConfig
}

export interface V2LaunchdProcessSupervisorAdapter {
  readonly up: (
    provider: V2ProviderPluginForFamily<"process-supervisor">,
    input: V2LaunchdProcessSupervisorInput,
  ) => Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError>
  readonly down: (
    provider: V2ProviderPluginForFamily<"process-supervisor">,
    input: V2LaunchdProcessSupervisorInput,
  ) => Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError>
  readonly restart: (
    provider: V2ProviderPluginForFamily<"process-supervisor">,
    input: V2LaunchdProcessSupervisorInput,
  ) => Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError>
}

export const launchdProcessSupervisorProvider = {
  id: "launchd",
  family: "process-supervisor",
  source: "first-party",
  displayName: "launchd",
  capabilities: ["user-agent", "restart-policy", "v1-compatible"],
} satisfies V2ProviderPlugin

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const guiDomain = (): string => `gui/${getuid!()}`

const launchdLabelPart = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "component"

export const launchdLabel = (deployment: V2DeploymentRecord, service: V2RuntimeServiceConfig): string =>
  [
    RIG_V2_LAUNCHD_LABEL_PREFIX,
    launchdLabelPart(deployment.project),
    launchdLabelPart(deployment.name),
    launchdLabelPart(service.name),
  ].join(".")

export const launchdPlistPath = (home: string, label: string): string =>
  join(home, "Library", "LaunchAgents", `${label}.plist`)

const launchdLogPath = (deployment: V2DeploymentRecord, service: V2RuntimeServiceConfig): string =>
  join(deployment.logRoot, `${service.name}.launchd.log`)

export const launchdPlist = (input: {
  readonly label: string
  readonly command: string
  readonly workdir: string
  readonly logPath: string
  readonly keepAlive: boolean
}): string =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t<string>${escapeXml(input.label)}</string>`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    `\t\t<string>/bin/sh</string>`,
    `\t\t<string>-lc</string>`,
    `\t\t<string>${escapeXml(input.command)}</string>`,
    `\t</array>`,
    `\t<key>WorkingDirectory</key>`,
    `\t<string>${escapeXml(input.workdir)}</string>`,
    `\t<key>KeepAlive</key>`,
    `\t<${input.keepAlive}/>`,
    `\t<key>StandardOutPath</key>`,
    `\t<string>${escapeXml(input.logPath)}</string>`,
    `\t<key>StandardErrorPath</key>`,
    `\t<string>${escapeXml(input.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
  ].join("\n") + "\n"

const operationName = (
  provider: V2ProviderPlugin,
  action: "up" | "down" | "restart",
  service: V2RuntimeServiceConfig,
  suffix?: string,
): string =>
  `${provider.family}:${provider.id}:${action}:${service.name}${suffix ? `:${suffix}` : ""}`

export const createLaunchdProcessSupervisorAdapter = (
  options: V2LaunchdProcessSupervisorOptions | undefined,
  defaultCommandRunner: V2LaunchdCommandRunner,
): V2LaunchdProcessSupervisorAdapter => {
  const runLaunchd = options?.runCommand ?? defaultCommandRunner
  const launchdHome = options?.home ?? homedir()

  const installLaunchdProcess = (
    provider: V2ProviderPlugin,
    input: V2LaunchdProcessSupervisorInput,
  ): Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError> => {
    if (!("command" in input.service)) {
      return Effect.fail(
        new V2RuntimeError(
          `Component '${input.service.name}' cannot be installed as a launchd process.`,
          "Only managed server components with a command can use the launchd process supervisor.",
          {
            providerId: provider.id,
            component: input.service.name,
            deployment: input.deployment.name,
          },
        ),
      )
    }

    return Effect.tryPromise({
      try: async () => {
        const label = launchdLabel(input.deployment, input.service)
        const path = launchdPlistPath(launchdHome, label)
        const logPath = launchdLogPath(input.deployment, input.service)
        const domain = guiDomain()

        await Effect.runPromise(platformMakeDirectory(join(launchdHome, "Library", "LaunchAgents")))
        await Effect.runPromise(platformMakeDirectory(input.deployment.logRoot))
        await Effect.runPromise(platformWriteFileString(
          path,
          launchdPlist({
            label,
            command: input.service.command,
            workdir: input.deployment.workspacePath,
            logPath,
            keepAlive: input.deployment.resolved.v1Config?.daemon?.keepAlive ?? false,
          }),
        ))

        await runLaunchd(["launchctl", "bootout", `${domain}/${label}`])
        const result = await runLaunchd(["launchctl", "bootstrap", domain, path])
        if (result.exitCode !== 0) {
          throw new V2RuntimeError(
            `launchd failed to bootstrap '${input.service.name}' with exit code ${result.exitCode}.`,
            "Inspect the generated plist and launchctl stderr, then retry the lifecycle action.",
            {
              providerId: provider.id,
              component: input.service.name,
              deployment: input.deployment.name,
              label,
              plistPath: path,
              stderr: result.stderr,
            },
          )
        }

        return {
          operation: operationName(provider, "up", input.service, "installed"),
        } satisfies V2ProcessSupervisorOperationResult
      },
      catch: (cause) =>
        cause instanceof V2RuntimeError
          ? cause
          : new V2RuntimeError(
            `Unable to install launchd process '${input.service.name}'.`,
            "Ensure the v2 launchd plist directory is writable and retry.",
            {
              providerId: provider.id,
              component: input.service.name,
              deployment: input.deployment.name,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          ),
    })
  }

  const removeLaunchdProcess = (
    provider: V2ProviderPlugin,
    input: V2LaunchdProcessSupervisorInput,
  ): Effect.Effect<V2ProcessSupervisorOperationResult, V2RuntimeError> =>
    Effect.tryPromise({
      try: async () => {
        const label = launchdLabel(input.deployment, input.service)
        const path = launchdPlistPath(launchdHome, label)
        const result = await runLaunchd(["launchctl", "bootout", `${guiDomain()}/${label}`])
        if (result.exitCode !== 0) {
          const stderr = result.stderr.toLowerCase()
          const isNotLoaded =
            stderr.includes("no such process") ||
            stderr.includes("could not find service") ||
            stderr.includes("not loaded") ||
            result.exitCode === 3
          if (!isNotLoaded) {
            throw new V2RuntimeError(
              `launchd failed to bootout '${input.service.name}' with exit code ${result.exitCode}.`,
              "Inspect launchctl stderr and retry the lifecycle action.",
              {
                providerId: provider.id,
                component: input.service.name,
                deployment: input.deployment.name,
                label,
                stderr: result.stderr,
              },
            )
          }
        }

        await Effect.runPromise(platformRemove(path, { force: true }))
        return {
          operation: operationName(provider, "down", input.service, "removed"),
        } satisfies V2ProcessSupervisorOperationResult
      },
      catch: (cause) =>
        cause instanceof V2RuntimeError
          ? cause
          : new V2RuntimeError(
            `Unable to remove launchd process '${input.service.name}'.`,
            "Ensure the v2 launchd plist path is writable and retry.",
            {
              providerId: provider.id,
              component: input.service.name,
              deployment: input.deployment.name,
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          ),
    })

  return {
    up: installLaunchdProcess,
    down: removeLaunchdProcess,
    restart: (provider, input) =>
      Effect.gen(function* () {
        yield* removeLaunchdProcess(provider, input)
        return yield* installLaunchdProcess(provider, input)
      }),
  }
}
