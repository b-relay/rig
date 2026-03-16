import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  createSmokeProject,
  firstErrorRecord,
  firstTableRecord,
  helpFragmentsForCommand,
  infoMessages,
  runSmokeCommand,
  successMessages,
} from "./cli-smoke-harness.js"

describe("compiled rig-smoke command surface E2E", () => {
  test("init registers a project structurally and rejects missing args with help", async () => {
    const project = await createSmokeProject()

    try {
      const invalid = await runSmokeCommand(project, ["init", project.name])
      const invalidError = firstErrorRecord(invalid)

      expect(invalid.exitCode).toBe(1)
      expect(invalidError?.error?._tag).toBe("CliArgumentError")
      for (const fragment of helpFragmentsForCommand("init")) {
        expect(invalid.stdout).toContain(fragment)
      }

      const success = await runSmokeCommand(project, ["init", project.name, "--path", project.repoPath])
      expect(success.exitCode).toBe(0)
      expect(successMessages(success).some((record) => record.message?.includes("Registered") === true)).toBe(true)
    } finally {
      await project.cleanup()
    }
  })

  test("restart restarts services and changes the tracked pid", async () => {
    const project = await createSmokeProject()

    try {
      await runSmokeCommand(project, ["init", project.name, "--path", project.repoPath])
      await runSmokeCommand(project, ["start", project.name, "dev"])

      const before = await runSmokeCommand(project, ["status", project.name, "dev"])
      const beforeRow = (firstTableRecord(before)?.rows ?? []).find((row) => row.service === "web")

      const restarted = await runSmokeCommand(project, ["restart", "dev"])
      expect(restarted.exitCode).toBe(0)
      expect(successMessages(restarted).some((record) => record.message?.includes("Services stopped.") === true)).toBe(true)
      expect(successMessages(restarted).some((record) => record.message?.includes("Services started.") === true)).toBe(true)

      const after = await runSmokeCommand(project, ["status", project.name, "dev"])
      const afterRow = (firstTableRecord(after)?.rows ?? []).find((row) => row.service === "web")

      expect(typeof beforeRow?.pid).toBe("number")
      expect(typeof afterRow?.pid).toBe("number")
      expect(afterRow?.pid).not.toBe(beforeRow?.pid)
    } finally {
      await project.cleanup()
    }
  })

  test("logs defaults to the only service and returns bounded history", async () => {
    const project = await createSmokeProject()

    try {
      await runSmokeCommand(project, ["init", project.name, "--path", project.repoPath])
      await runSmokeCommand(project, ["start", project.name, "dev"])
      await new Promise((resolve) => setTimeout(resolve, 700))

      const result = await runSmokeCommand(project, ["logs", "dev", "--lines", "5"])
      expect(result.exitCode).toBe(0)

      const messages = infoMessages(result)
      expect(messages.some((message) => message.includes("web"))).toBe(true)
      expect(messages.length).toBeLessThanOrEqual(5)
    } finally {
      await project.cleanup()
    }
  })

  test("logs interleaves multi-service history and follow streams appended lines", async () => {
    const project = await createSmokeProject({ multiService: true })

    try {
      await runSmokeCommand(project, ["init", project.name, "--path", project.repoPath])
      await runSmokeCommand(project, ["start", project.name, "dev"])
      await new Promise((resolve) => setTimeout(resolve, 800))

      const interleaved = await runSmokeCommand(project, ["logs", project.name, "dev", "--lines", "6"])
      const historyMessages = infoMessages(interleaved)

      expect(interleaved.exitCode).toBe(0)
      expect(historyMessages.some((message) => message.startsWith("web |"))).toBe(true)
      expect(historyMessages.some((message) => message.startsWith("worker |"))).toBe(true)
      expect(historyMessages.length).toBeLessThanOrEqual(6)

      const follow = await runSmokeCommand(
        project,
        ["logs", project.name, "dev", "--follow", "--lines", "2"],
        { waitForMs: 900, signal: "SIGINT" },
      )

      expect(follow.exitCode).toBe(130)
      expect(infoMessages(follow).some((message) => message.includes("tick"))).toBe(true)
    } finally {
      await project.cleanup()
    }
  })

  test("version defaults to release history, supports detail, and can edit the latest release semver", async () => {
    const project = await createSmokeProject()

    try {
      await runSmokeCommand(project, ["init", project.name, "--path", project.repoPath])
      await runSmokeCommand(project, ["deploy", project.name, "prod", "--bump", "minor"])

      const history = await runSmokeCommand(project, ["version", project.name])
      const historyRows = firstTableRecord(history)?.rows ?? []

      expect(history.exitCode).toBe(0)
      expect(historyRows[0]?.version).toBe("0.2.0")
      expect(typeof historyRows[0]?.commit).toBe("string")
      expect(String(historyRows[0]?.commit).length).toBe(7)

      const detail = await runSmokeCommand(project, ["version", project.name, "0.2.0"])
      expect(detail.exitCode).toBe(0)
      expect(infoMessages(detail).some((message) => message.includes("resolved release"))).toBe(true)

      const edited = await runSmokeCommand(project, ["version", project.name, "0.2.0", "--edit", "0.2.1"])
      expect(edited.exitCode).toBe(0)
      expect(successMessages(edited).some((record) => record.message?.includes("Release version updated.") === true)).toBe(true)

      const updated = await runSmokeCommand(project, ["version", project.name])
      expect((firstTableRecord(updated)?.rows ?? [])[0]?.version).toBe("0.2.1")
    } finally {
      await project.cleanup()
    }
  })

  test("config shows project data, set updates a primitive, and unset removes it", async () => {
    const project = await createSmokeProject()

    try {
      await runSmokeCommand(project, ["init", project.name, "--path", project.repoPath])

      const shown = await runSmokeCommand(project, ["config", project.name])
      expect(shown.exitCode).toBe(0)
      expect(infoMessages(shown).some((message) => message.includes(`Project: ${project.name}`))).toBe(true)

      const setResult = await runSmokeCommand(project, ["config", "set", project.name, "description", "Updated description"])
      expect(setResult.exitCode).toBe(0)

      const afterSet = JSON.parse(await readFile(join(project.repoPath, "rig.json"), "utf8")) as {
        readonly description?: string
      }
      expect(afterSet.description).toBe("Updated description")

      const unsetResult = await runSmokeCommand(project, ["config", "unset", project.name, "description"])
      expect(unsetResult.exitCode).toBe(0)

      const afterUnset = JSON.parse(await readFile(join(project.repoPath, "rig.json"), "utf8")) as {
        readonly description?: string
      }
      expect("description" in afterUnset).toBe(false)
    } finally {
      await project.cleanup()
    }
  })

  test("config set rejects unsupported non-primitive values and points to docs", async () => {
    const project = await createSmokeProject()

    try {
      await runSmokeCommand(project, ["init", project.name, "--path", project.repoPath])

      const result = await runSmokeCommand(project, [
        "config",
        "set",
        project.name,
        "description",
        "{\"nested\":true}",
      ])
      const error = firstErrorRecord(result)

      expect(result.exitCode).toBe(1)
      expect(error?.error?._tag).toBe("ConfigValidationError")
      expect(error?.error?.message).toContain("primitive")
      expect(error?.error?.hint).toContain("string, number, boolean, or null")
    } finally {
      await project.cleanup()
    }
  })

  test("list shows registered projects and current prod deployment", async () => {
    const project = await createSmokeProject()

    try {
      await runSmokeCommand(project, ["init", project.name, "--path", project.repoPath])
      await runSmokeCommand(project, ["deploy", project.name, "prod", "--bump", "minor"])

      const result = await runSmokeCommand(project, ["list"])
      const rows = firstTableRecord(result)?.rows ?? []

      expect(result.exitCode).toBe(0)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.name).toBe(project.name)
      expect(rows[0]?.currentProdVersion).toBe("0.2.0")
      expect(typeof rows[0]?.registeredAt).toBe("string")
    } finally {
      await project.cleanup()
    }
  })

  test("docs lists config keys briefly and key detail shows long description and config-set guidance", async () => {
    const project = await createSmokeProject()

    try {
      const toc = await runSmokeCommand(project, ["docs"])
      expect(toc.exitCode).toBe(0)
      expect(infoMessages(toc).some((message) => message.includes("config"))).toBe(true)

      const configDocs = await runSmokeCommand(project, ["docs", "config"])
      expect(configDocs.exitCode).toBe(0)
      expect(infoMessages(configDocs).some((message) => message.includes("version ("))).toBe(true)

      const detail = await runSmokeCommand(project, ["docs", "config", "description"])
      expect(detail.exitCode).toBe(0)
      expect(infoMessages(detail).some((message) => message.includes("settable"))).toBe(true)
      expect(infoMessages(detail).some((message) => message.includes("rig config"))).toBe(true)

      const onboardList = await runSmokeCommand(project, ["docs", "onboard"])
      expect(onboardList.exitCode).toBe(0)
      expect(infoMessages(onboardList).some((message) => message.includes("nextjs"))).toBe(true)
      expect(infoMessages(onboardList).some((message) => message.includes("convex"))).toBe(true)
      expect(infoMessages(onboardList).some((message) => message.includes("rig-smoke"))).toBe(false)

      const onboardDetail = await runSmokeCommand(project, ["docs", "onboard", "vite"])
      expect(onboardDetail.exitCode).toBe(0)
      expect(infoMessages(onboardDetail).some((message) => message.includes("Important Notes:"))).toBe(true)
      expect(infoMessages(onboardDetail).some((message) => message.includes("example localhost ports"))).toBe(true)
      expect(infoMessages(onboardDetail).some((message) => message.includes("Agent Guidance:"))).toBe(true)
      expect(infoMessages(onboardDetail).some((message) => message.includes("Do not tell AI agents"))).toBe(true)
      expect(infoMessages(onboardDetail).some((message) => message.includes("Validation:"))).toBe(false)
    } finally {
      await project.cleanup()
    }
  })

  test("config help and logs invalid service errors remain structural instead of snapshot-based", async () => {
    const project = await createSmokeProject({ multiService: true })

    try {
      const help = await runSmokeCommand(project, ["config", "--help"], { json: false })
      expect(help.exitCode).toBe(0)
      for (const fragment of helpFragmentsForCommand("config")) {
        expect(help.stdout).toContain(fragment)
      }

      await runSmokeCommand(project, ["init", project.name, "--path", project.repoPath])
      await runSmokeCommand(project, ["start", project.name, "dev"])

      const invalidService = await runSmokeCommand(project, ["logs", project.name, "dev", "--service", "missing"])
      const error = firstErrorRecord(invalidService)

      expect(invalidService.exitCode).toBe(1)
      expect(error?.error?._tag).toBe("CliArgumentError")
      expect(error?.error?.message).toContain("Service 'missing'")
      expect(error?.error?.hint).toContain("omit --service")
    } finally {
      await project.cleanup()
    }
  })
})
