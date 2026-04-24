import { createServer } from "node:net"

import { describe, expect, test } from "bun:test"

import { ONBOARDING_TOPICS, type OnboardingVariantDefinition } from "../core/onboarding-docs.js"
import {
  appendRepoChange,
  createSmokeFixtureProject,
  firstTableRecord,
  infoMessages,
  runSmokeCommand,
  successMessages,
  type SmokeCommandResult,
  type SmokeProject,
} from "./cli-smoke-harness.js"

const allocatePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate onboarding test port."))
        return
      }

      const port = address.port
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(port)
      })
    })
  })

const allocatePorts = async (
  defaults: Readonly<Record<string, number>>,
): Promise<Record<string, number>> => {
  const entries = await Promise.all(
    Object.keys(defaults).map(async (key) => [key, await allocatePort()] as const),
  )
  return Object.fromEntries(entries)
}

const runShellCommand = async (
  project: { readonly repoPath: string; readonly homeDir: string; readonly rigRootDir: string },
  cmd: readonly string[],
) => {
  const child = Bun.spawn({
    cmd: [...cmd],
    cwd: project.repoPath,
    env: {
      ...process.env,
      HOME: project.homeDir,
      RIG_ROOT: project.rigRootDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
    child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
    child.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed:\n${stdout}\n${stderr}`.trim())
  }
}

const splitRigCommand = (command: string): readonly string[] => {
  if (!command.startsWith("rig ")) {
    throw new Error(`Expected a rig command, got '${command}'.`)
  }

  return command
    .slice(4)
    .trim()
    .split(/\s+/)
}

const assertRigCommandResult = (command: string, result: SmokeCommandResult) => {
  if (command.includes("--follow")) {
    expect([0, 130]).toContain(result.exitCode)
    expect(infoMessages(result).length).toBeGreaterThan(0)
    return
  }

  expect(result.exitCode).toBe(0)

  if (command.startsWith("rig init ")) {
    expect(successMessages(result).some((record) => record.message?.includes("Registered") === true)).toBe(true)
    return
  }

  if (command.startsWith("rig start ")) {
    expect(successMessages(result).some((record) => record.message?.includes("Services started.") === true)).toBe(true)
    return
  }

  if (command.startsWith("rig stop ")) {
    expect(successMessages(result).some((record) => record.message?.includes("Services stopped.") === true)).toBe(true)
    return
  }

  if (command.startsWith("rig deploy ")) {
    expect(successMessages(result).some((record) => record.message?.includes("Deploy applied.") === true)).toBe(true)
    return
  }

  if (command.startsWith("rig status ")) {
    expect((firstTableRecord(result)?.rows ?? []).length).toBeGreaterThan(0)
    return
  }

  if (command.startsWith("rig logs ")) {
    expect(infoMessages(result).length).toBeGreaterThan(0)
  }
}

const runDocumentedCommand = async (
  project: SmokeProject,
  command: string,
) => {
  if (command === "npm install") {
    await runShellCommand(project, ["npm", "install"])
    return
  }

  if (command.startsWith("git add . && git commit -m ")) {
    await appendRepoChange(project)
    await project.commitAll("feat: release")
    return
  }

  const argv = splitRigCommand(command)
  const result = await runSmokeCommand(project, argv, command.includes("--follow")
    ? { waitForMs: 900, signal: "SIGINT" }
    : undefined)

  assertRigCommandResult(command, result)
}

const validateVariant = async (variant: OnboardingVariantDefinition, topicId: string) => {
  const projectName = "my-app"
  const ports = await allocatePorts(variant.defaultPorts)
  const projectSpec = variant.buildProject({
    projectName,
    ports,
  })
  const project = await createSmokeFixtureProject({
    name: projectName,
    rigConfig: projectSpec.rigConfig,
    files: projectSpec.files,
  })

  try {
    const docs = await runSmokeCommand(project, ["docs", "onboard", topicId])
    expect(docs.exitCode).toBe(0)
    expect(infoMessages(docs).some((message) => message.includes(variant.title))).toBe(true)
    expect(infoMessages(docs).some((message) => message.includes("Important Notes:"))).toBe(true)
    expect(infoMessages(docs).some((message) => message.includes("Agent Guidance:"))).toBe(true)
    expect(infoMessages(docs).some((message) => message.includes("rig-smoke"))).toBe(false)

    for (const command of variant.setupCommands) {
      await runDocumentedCommand(project, command)
    }

    for (const command of variant.devCommands) {
      await runDocumentedCommand(project, command)
    }

    for (const command of variant.prodCommands) {
      await runDocumentedCommand(project, command)
    }
  } finally {
    await project.cleanup()
  }
}

describe("compiled main rig binary onboarding recipe validation", () => {
  for (const topic of ONBOARDING_TOPICS) {
    for (const variant of topic.variants) {
      test(
        `${topic.id} onboarding variant '${variant.id}' runs the documented flow`,
        async () => {
          await validateVariant(variant, topic.id)
        },
        20000,
      )
    }
  }
})
