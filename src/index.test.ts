import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

type EnvUpdates = Record<string, string | undefined>

const buildEnv = (updates: EnvUpdates): Record<string, string> => {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }

  return env
}

const runRigCommand = async (argv: readonly string[], envUpdates: EnvUpdates) => {
  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", "src/index.ts", ...argv],
    cwd: process.cwd(),
    env: buildEnv(envUpdates),
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    processHandle.stdout ? new Response(processHandle.stdout).text() : Promise.resolve(""),
    processHandle.stderr ? new Response(processHandle.stderr).text() : Promise.resolve(""),
    processHandle.exited,
  ])

  return { stdout, stderr, exitCode }
}

describe("GIVEN suite context WHEN logger output targets are configured through env vars THEN behavior is covered", () => {
  test("GIVEN RIG_LOG_FILE is set WHEN running a command THEN output appears in both terminal and file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "rig-log-targets-"))
    const logPath = join(tempRoot, "rig.log")

    try {
      const { stdout, stderr, exitCode } = await runRigCommand(["config"], {
        RIG_LOG_FILE: logPath,
        RIG_LOG_FORMAT: undefined,
      })

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("\u001b[34mi\u001b[0m")
      expect(stdout).toContain("rig.json schema reference")

      const fileOutput = await readFile(logPath, "utf8")
      expect(fileOutput).toContain("[INFO] rig.json schema reference")
      expect(fileOutput).toContain("description:")
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN RIG_LOG_FORMAT=json and RIG_LOG_FILE is set WHEN running THEN JSON goes to stdout and plain text goes to file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "rig-log-targets-"))
    const logPath = join(tempRoot, "rig.log")

    try {
      const { stdout, stderr, exitCode } = await runRigCommand(["config"], {
        RIG_LOG_FILE: logPath,
        RIG_LOG_FORMAT: "json",
      })

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")

      const firstLine = stdout.trim().split("\n")[0] ?? ""
      const parsed = JSON.parse(firstLine) as {
        readonly level?: string
        readonly message?: string
      }

      expect(parsed.level).toBe("info")
      expect(parsed.message).toBe("rig.json schema reference")

      const fileOutput = await readFile(logPath, "utf8")
      expect(fileOutput).toContain("[INFO] rig.json schema reference")
      expect(fileOutput.includes('"level":"info"')).toBe(false)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test("GIVEN neither env var is set WHEN running THEN TerminalLoggerLive is used", async () => {
    const { stdout, stderr, exitCode } = await runRigCommand(["config"], {
      RIG_LOG_FILE: undefined,
      RIG_LOG_FORMAT: undefined,
    })

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("\u001b[34mi\u001b[0m")
    expect(stdout).toContain("rig.json schema reference")

    const firstLine = stdout.trim().split("\n")[0] ?? ""
    expect(firstLine.startsWith("{")).toBe(false)
  })
})
