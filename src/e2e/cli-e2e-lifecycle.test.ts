import { describe, expect, test } from "bun:test"

import {
  appendRepoChange,
  createE2EProject,
  firstErrorRecord,
  firstTableRecord,
  helpFragmentsForCommand,
  infoMessages,
  runE2ECommand,
  successMessages,
} from "./cli-e2e-harness.js"

describe("compiled main rig binary lifecycle CLI E2E", () => {
  test("start shows command help structurally", async () => {
    const project = await createE2EProject()

    try {
      const result = await runE2ECommand(project, ["start", "--help"], { json: false })

      expect(result.exitCode).toBe(0)
      for (const fragment of helpFragmentsForCommand("start")) {
        expect(result.stdout).toContain(fragment)
      }
    } finally {
      await project.cleanup()
    }
  })

  test("start rejects missing environment with hint and subcommand help", async () => {
    const project = await createE2EProject()

    try {
      const result = await runE2ECommand(project, ["start", project.name])
      const error = firstErrorRecord(result)

      expect(result.exitCode).toBe(1)
      expect(error?.error?._tag).toBe("CliArgumentError")
      expect(error?.error?.message).toContain("environment")
      expect(error?.error?.hint).toContain("Usage:")
      for (const fragment of helpFragmentsForCommand("start")) {
        expect(result.stdout).toContain(fragment)
      }
    } finally {
      await project.cleanup()
    }
  })

  test("start rejects cwd autodetect when rig.json is missing", async () => {
    const project = await createE2EProject()

    try {
      const result = await runE2ECommand(project, ["start", "dev"], { cwd: project.tempRoot })
      const error = firstErrorRecord(result)

      expect(result.exitCode).toBe(1)
      expect(error?.error?._tag).toBe("CliArgumentError")
      expect(error?.error?.message).toContain("rig.json")
      expect(error?.error?.hint).toContain("Usage:")
    } finally {
      await project.cleanup()
    }
  })

  test("start fails structurally when registry entry is missing", async () => {
    const project = await createE2EProject()

    try {
      const result = await runE2ECommand(project, ["start", project.name, "dev"])
      const error = firstErrorRecord(result)

      expect(result.exitCode).toBe(1)
      expect(error?.error?._tag).toBe("ConfigValidationError")
      expect(error?.error?.message).toContain("resolve project")
      expect(error?.error?.hint).toContain("rig init")
    } finally {
      await project.cleanup()
    }
  })

  test("start and stop support cwd autodetect and surface runtime state structurally", async () => {
    const project = await createE2EProject()

    try {
      expect((await runE2ECommand(project, ["init", project.name, "--path", project.repoPath])).exitCode).toBe(0)

      const started = await runE2ECommand(project, ["start", "dev"])
      expect(started.exitCode).toBe(0)
      expect(successMessages(started).some((record) => record.message?.includes("Services started.") === true)).toBe(true)

      const statusRunning = await runE2ECommand(project, ["status", project.name, "dev"])
      const runningRows = firstTableRecord(statusRunning)?.rows ?? []
      const webRow = runningRows.find((row) => row.service === "web")

      expect(statusRunning.exitCode).toBe(0)
      expect(webRow?.env).toBe("dev")
      expect(webRow?.port).toBe(project.ports.web)
      expect(typeof webRow?.pid).toBe("number")
      expect(webRow?.alive).toBe(true)

      const stopped = await runE2ECommand(project, ["stop", "dev"])
      expect(stopped.exitCode).toBe(0)
      expect(successMessages(stopped).some((record) => record.message?.includes("Services stopped.") === true)).toBe(true)

      const statusStopped = await runE2ECommand(project, ["status", project.name, "dev"])
      const stoppedRows = firstTableRecord(statusStopped)?.rows ?? []
      const stoppedRow = stoppedRows.find((row) => row.env === "dev")

      expect(stoppedRow?.pid).toBe(null)
      expect(stoppedRow?.alive).toBe(null)
    } finally {
      await project.cleanup()
    }
  })

  test("deploy dev runs successfully and start/stop state is visible in status", async () => {
    const project = await createE2EProject()

    try {
      await runE2ECommand(project, ["init", project.name, "--path", project.repoPath])

      const deployed = await runE2ECommand(project, ["deploy", "dev"])
      expect(deployed.exitCode).toBe(0)
      expect(successMessages(deployed).some((record) => record.message?.includes("Deploy applied.") === true)).toBe(true)

      const status = await runE2ECommand(project, ["status", project.name, "dev"])
      const rows = firstTableRecord(status)?.rows ?? []
      const row = rows.find((entry) => entry.env === "dev")

      expect(row?.service).toBe("web")
      expect(row?.port).toBe(project.ports.web)
      expect(typeof row?.pid).toBe("number")
    } finally {
      await project.cleanup()
    }
  })

  test("deploy rejects mutually exclusive release selectors structurally", async () => {
    const project = await createE2EProject()

    try {
      await runE2ECommand(project, ["init", project.name, "--path", project.repoPath])

      const result = await runE2ECommand(project, [
        "deploy",
        project.name,
        "prod",
        "--bump",
        "minor",
        "--version",
        "1.2.3",
      ])
      const error = firstErrorRecord(result)

      expect(result.exitCode).toBe(1)
      expect(error?.error?._tag).toBe("CliArgumentError")
      expect(error?.error?.hint).toContain("Usage:")
      for (const fragment of helpFragmentsForCommand("deploy")) {
        expect(result.stdout).toContain(fragment)
      }
    } finally {
      await project.cleanup()
    }
  })

  test("prod deploy creates a real release, updates status, and supports cwd autodetect", async () => {
    const project = await createE2EProject()

    try {
      await runE2ECommand(project, ["init", project.name, "--path", project.repoPath])

      const deployed = await runE2ECommand(project, ["deploy", "prod", "--bump", "minor"])
      expect(deployed.exitCode).toBe(0)

      const status = await runE2ECommand(project, ["status", project.name, "prod"])
      const row = (firstTableRecord(status)?.rows ?? []).find((entry) => entry.env === "prod")

      expect(row?.latestProdVersion).toBe("0.2.0")
      expect(row?.currentProdVersion).toBe("0.2.0")
      expect(typeof row?.pid).toBe("number")

      const version = await runE2ECommand(project, ["version"])
      const rows = firstTableRecord(version)?.rows ?? []
      expect(rows[0]?.version).toBe("0.2.0")
      expect(rows[0]?.markers).toContain("latest")
      expect(rows[0]?.markers).toContain("current")
    } finally {
      await project.cleanup()
    }
  })

  test("prod deploy supports rollback by --version and latest-only revert while pinned older", async () => {
    const project = await createE2EProject()

    try {
      await runE2ECommand(project, ["init", project.name, "--path", project.repoPath])

      expect((await runE2ECommand(project, ["deploy", "prod", "--bump", "minor"])).exitCode).toBe(0)

      await appendRepoChange(project)
      await project.commitAll("feat: advance release")
      expect((await runE2ECommand(project, ["deploy", "prod", "--bump", "minor"])).exitCode).toBe(0)

      const rollback = await runE2ECommand(project, ["deploy", project.name, "prod", "--version", "0.2.0"])
      expect(rollback.exitCode).toBe(0)

      const reverted = await runE2ECommand(project, ["deploy", project.name, "prod", "--revert", "0.3.0"])
      expect(reverted.exitCode).toBe(0)
      expect(infoMessages(reverted).some((message) => message.includes("without changing active runtime"))).toBe(true)

      const status = await runE2ECommand(project, ["status", project.name, "prod"])
      const row = (firstTableRecord(status)?.rows ?? []).find((entry) => entry.env === "prod")

      expect(row?.currentProdVersion).toBe("0.2.0")
      expect(row?.latestProdVersion).toBe("0.2.0")
    } finally {
      await project.cleanup()
    }
  })

  test("status supports global view and shows latest/current prod versions", async () => {
    const project = await createE2EProject()

    try {
      await runE2ECommand(project, ["init", project.name, "--path", project.repoPath])
      await runE2ECommand(project, ["deploy", project.name, "prod", "--bump", "minor"])

      const result = await runE2ECommand(project, ["status"])
      const rows = firstTableRecord(result)?.rows ?? []

      expect(result.exitCode).toBe(0)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.name).toBe(project.name)
      expect(rows[0]?.latestProdVersion).toBe("0.2.0")
      expect(rows[0]?.currentProdVersion).toBe("0.2.0")
      expect(typeof rows[0]?.repoPath).toBe("string")
    } finally {
      await project.cleanup()
    }
  })
})
