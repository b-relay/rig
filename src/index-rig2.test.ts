import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const runRig2Command = async (argv: readonly string[], env: Record<string, string>) => {
  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", "src/index-rig2.ts", ...argv],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
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

describe("GIVEN rig2 entrypoint WHEN executed directly THEN behavior is covered", () => {
  test("GIVEN status command WHEN run through src/index-rig2.ts THEN it uses the isolated v2 root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRig2Command(
        ["status", "--project", "pantry"],
        { RIG_V2_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig2 foundation ready")
      expect(stdout).toContain("[INFO] rigd status")
      expect(stdout).toContain(`"stateRoot":"${root}"`)
      expect(stdout).toContain('"namespace":"rig.v2.pantry"')
      expect(stdout).toContain('"launchdLabelPrefix":"com.b-relay.rig2"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN up command without project WHEN run from repo THEN it infers current project", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRig2Command(
        ["up", "--state-root", root],
        { RIG_V2_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rig2 lifecycle intent")
      expect(stdout).toContain('"project":"rig"')
      expect(stdout).toContain('"lane":"local"')
      expect(stdout).toContain(`"stateRoot":"${root}"`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN rigd command WHEN run directly THEN it starts the local MVP API", async () => {
    const root = await mkdtemp(join(tmpdir(), "rig2-root-"))

    try {
      const { stdout, stderr, exitCode } = await runRig2Command(
        ["rigd", "--state-root", root],
        { RIG_V2_ROOT: root },
      )

      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("[INFO] rigd local API ready")
      expect(stdout).toContain('"service":"rigd"')
      expect(stdout).toContain('"transport":"outbound-websocket"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("GIVEN v2 lifecycle command help WHEN run directly THEN Effect CLI renders subcommand help", async () => {
    const { stdout, stderr, exitCode } = await runRig2Command(["up", "--help"], {})

    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("Start a v2 local or live lane.")
    expect(stdout).toContain("--project string")
    expect(stdout).toContain("--lane choice")
    expect(stdout).toContain("--help, -h")
  })
})
