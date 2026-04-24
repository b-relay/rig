import { describe, expect, test } from "bun:test"

import {
  createE2EProject,
  firstErrorRecord,
  helpFragmentsForCommand,
  mainHelpFragments,
  runE2ECommand,
} from "./cli-e2e-harness.js"

describe("compiled main rig binary CLI argument and discovery matrix", () => {
  test("commands that support cwd autodetect fail clearly when rig.json is missing", async () => {
    const project = await createE2EProject()

    try {
      const cases = [
        { argv: ["deploy", "dev"], command: "deploy" as const },
        { argv: ["start", "dev"], command: "start" as const },
        { argv: ["stop", "dev"], command: "stop" as const },
        { argv: ["restart", "dev"], command: "restart" as const },
        { argv: ["logs", "dev"], command: "logs" as const },
        { argv: ["version"], command: "version" as const },
        { argv: ["config"], command: "config" as const },
      ]

      for (const entry of cases) {
        const result = await runE2ECommand(project, entry.argv, { cwd: project.tempRoot })
        const error = firstErrorRecord(result)

        expect(result.exitCode).toBe(1)
        expect(error?.error?._tag).toBe("CliArgumentError")
        expect(error?.error?.message).toContain("rig.json")
        for (const fragment of helpFragmentsForCommand(entry.command)) {
          expect(result.stdout).toContain(fragment)
        }
      }
    } finally {
      await project.cleanup()
    }
  })

  test("registered-project commands fail structurally when the registry entry is missing", async () => {
    const project = await createE2EProject()

    try {
      const cases = [
        ["deploy", project.name, "dev"],
        ["start", project.name, "dev"],
        ["stop", project.name, "dev"],
        ["restart", project.name, "dev"],
        ["status", project.name],
        ["logs", project.name, "dev"],
        ["version", project.name],
        ["config", project.name],
      ] as const

      for (const argv of cases) {
        const result = await runE2ECommand(project, argv)
        const error = firstErrorRecord(result)

        expect(result.exitCode).toBe(1)
        expect(
          error?.error?._tag !== undefined &&
            ["ConfigValidationError", "WorkspaceError"].includes(error.error._tag),
        ).toBe(true)
        expect(error?.error?.hint ?? "").toContain("rig init")
      }
    } finally {
      await project.cleanup()
    }
  })

  test("deploy, status, and list reject invalid or conflicting argument shapes structurally", async () => {
    const project = await createE2EProject()

    try {
      await runE2ECommand(project, ["init", project.name, "--path", project.repoPath])

      const invalidDeploy = await runE2ECommand(project, [
        "deploy",
        project.name,
        "prod",
        "--version",
        "1.2.3",
        "--revert",
        "1.2.3",
      ])
      expect(firstErrorRecord(invalidDeploy)?.error?._tag).toBe("CliArgumentError")

      const invalidStatus = await runE2ECommand(project, ["status", "prod", "--version", "1.2.3"])
      expect(firstErrorRecord(invalidStatus)?.error?.message).toContain("project name")

      const invalidList = await runE2ECommand(project, ["list", "extra"])
      expect(firstErrorRecord(invalidList)?.error?._tag).toBe("CliArgumentError")
      for (const fragment of helpFragmentsForCommand("list")) {
        expect(invalidList.stdout).toContain(fragment)
      }
    } finally {
      await project.cleanup()
    }
  })

  test("docs rejects unknown keys with guidance and global help is structurally rendered", async () => {
    const project = await createE2EProject()

    try {
      const unknownDocs = await runE2ECommand(project, ["docs", "config", "missing.key"])
      const error = firstErrorRecord(unknownDocs)

      expect(unknownDocs.exitCode).toBe(1)
      expect(error?.error?._tag).toBe("CliArgumentError")
      expect(error?.error?.hint).toContain("rig docs config")

      const mainHelp = await runE2ECommand(project, ["--help"], { json: false })
      expect(mainHelp.exitCode).toBe(0)
      for (const fragment of mainHelpFragments()) {
        expect(mainHelp.stdout).toContain(fragment)
      }
    } finally {
      await project.cleanup()
    }
  })

  test("config set and unset require valid arity and still render config help context", async () => {
    const project = await createE2EProject()

    try {
      const missingValue = await runE2ECommand(project, ["config", "set"])
      expect(firstErrorRecord(missingValue)?.error?._tag).toBe("CliArgumentError")
      expect(firstErrorRecord(missingValue)?.error?.hint ?? "").toContain("Usage:")

      const missingKey = await runE2ECommand(project, ["config", "unset"])
      expect(firstErrorRecord(missingKey)?.error?._tag).toBe("CliArgumentError")
      expect(firstErrorRecord(missingKey)?.error?.hint ?? "").toContain("Usage:")
    } finally {
      await project.cleanup()
    }
  })
})
