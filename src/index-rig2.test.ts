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
      expect(stdout).toContain(`"stateRoot":"${root}"`)
      expect(stdout).toContain('"namespace":"rig.v2.pantry"')
      expect(stdout).toContain('"launchdLabelPrefix":"com.b-relay.rig2"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
