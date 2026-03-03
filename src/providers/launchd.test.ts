import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { LaunchdManager, generatePlist, plistPath } from "./launchd.js"
import type { DaemonConfig } from "../interfaces/process-manager.js"

// ── Test helpers ────────────────────────────────────────────────────────────

const sampleConfig: DaemonConfig = {
  label: "pantry-prod",
  command: "/Users/clay/.rig/bin/rig",
  args: ["start", "pantry", "--prod", "--foreground"],
  keepAlive: true,
  envVars: { NODE_ENV: "production", PORT: "3070" },
  workdir: "/Users/clay/.rig/workspaces/pantry/prod/current",
  logPath: "/Users/clay/.rig/workspaces/pantry/prod/logs/pantry.log",
}

interface CapturedCommand {
  args: readonly string[]
}

const createMockRunner = (responses?: Record<string, { stdout: string; stderr: string; exitCode: number }>) => {
  const captured: CapturedCommand[] = []

  const runner = async (args: readonly string[]) => {
    captured.push({ args })
    const key = args.join(" ")
    if (responses && key in responses) {
      return responses[key]
    }
    // Default: success with empty output
    return { stdout: "", stderr: "", exitCode: 0 }
  }

  return { runner, captured }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "rig-launchd-test-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

// ── Tests ───────────────────────────────────────────────────────────────────

describe("generatePlist", () => {
  test("generates valid plist XML with all config fields", () => {
    const xml = generatePlist(sampleConfig)

    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain("<key>Label</key>")
    expect(xml).toContain("<string>pantry-prod</string>")
    expect(xml).toContain("<key>ProgramArguments</key>")
    expect(xml).toContain("<string>/Users/clay/.rig/bin/rig</string>")
    expect(xml).toContain("<string>start</string>")
    expect(xml).toContain("<string>pantry</string>")
    expect(xml).toContain("<string>--prod</string>")
    expect(xml).toContain("<string>--foreground</string>")
    expect(xml).toContain("<key>WorkingDirectory</key>")
    expect(xml).toContain("<key>EnvironmentVariables</key>")
    expect(xml).toContain("<key>NODE_ENV</key>")
    expect(xml).toContain("<string>production</string>")
    expect(xml).toContain("<key>PORT</key>")
    expect(xml).toContain("<string>3070</string>")
    expect(xml).toContain("<key>KeepAlive</key>")
    expect(xml).toContain("<true/>")
    expect(xml).toContain("<key>StandardOutPath</key>")
    expect(xml).toContain("<key>StandardErrorPath</key>")
  })

  test("generates KeepAlive false when disabled", () => {
    const config = { ...sampleConfig, keepAlive: false }
    const xml = generatePlist(config)
    expect(xml).toContain("<false/>")
    expect(xml).not.toContain("<true/>")
  })

  test("omits EnvironmentVariables dict when empty", () => {
    const config = { ...sampleConfig, envVars: {} }
    const xml = generatePlist(config)
    expect(xml).not.toContain("<key>EnvironmentVariables</key>")
  })

  test("escapes XML special characters", () => {
    const config = {
      ...sampleConfig,
      command: "/path/to/app&more",
      envVars: { KEY: "val<ue>" },
    }
    const xml = generatePlist(config)
    expect(xml).toContain("app&amp;more")
    expect(xml).toContain("val&lt;ue&gt;")
  })
})

describe("plistPath", () => {
  test("derives correct path from label", () => {
    const path = plistPath("pantry-prod", "/Users/clay")
    expect(path).toBe("/Users/clay/Library/LaunchAgents/com.b-relay.rig.pantry-prod.plist")
  })

  test("uses custom home directory", () => {
    const path = plistPath("myapp-dev", "/tmp/fakehome")
    expect(path).toBe("/tmp/fakehome/Library/LaunchAgents/com.b-relay.rig.myapp-dev.plist")
  })
})

describe("LaunchdManager", () => {
  test("install() writes plist and calls launchctl load", async () => {
    const { runner, captured } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    await run(mgr.install(sampleConfig))

    // Verify plist was written
    const expectedPath = plistPath(sampleConfig.label, tmpDir)
    const content = await readFile(expectedPath, "utf-8")
    expect(content).toContain("<key>Label</key>")
    expect(content).toContain("<string>pantry-prod</string>")

    // Verify launchctl load was called
    expect(captured).toHaveLength(1)
    expect(captured[0].args).toEqual(["launchctl", "load", expectedPath])
  })

  test("install() fails with ProcessError when launchctl load fails", async () => {
    const { runner } = createMockRunner({
      [`launchctl load ${plistPath(sampleConfig.label, tmpDir)}`]: {
        stdout: "",
        stderr: "Could not load plist",
        exitCode: 1,
      },
    })
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    const result = await Effect.runPromiseExit(mgr.install(sampleConfig))
    expect(result._tag).toBe("Failure")
  })

  test("uninstall() calls launchctl unload and deletes plist", async () => {
    const { runner, captured } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    // First install so the file exists
    await run(mgr.install(sampleConfig))

    // Now uninstall
    await run(mgr.uninstall(sampleConfig.label))

    // Should have called: load (install), unload (uninstall)
    expect(captured).toHaveLength(2)
    expect(captured[1].args[1]).toBe("unload")

    // File should be deleted
    const file = Bun.file(plistPath(sampleConfig.label, tmpDir))
    expect(await file.exists()).toBe(false)
  })

  test("start() calls launchctl start with label", async () => {
    const { runner, captured } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    await run(mgr.start("pantry-prod"))

    expect(captured).toHaveLength(1)
    expect(captured[0].args).toEqual(["launchctl", "start", "pantry-prod"])
  })

  test("stop() calls launchctl stop with label", async () => {
    const { runner, captured } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    await run(mgr.stop("pantry-prod"))

    expect(captured).toHaveLength(1)
    expect(captured[0].args).toEqual(["launchctl", "stop", "pantry-prod"])
  })

  test("status() returns loaded+running with PID when service is running", async () => {
    const { runner } = createMockRunner({
      "launchctl list pantry-prod": {
        stdout: `"PID" = 42381;\n"Label" = "pantry-prod";`,
        stderr: "",
        exitCode: 0,
      },
    })
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    const status = await run(mgr.status("pantry-prod"))
    expect(status.label).toBe("pantry-prod")
    expect(status.loaded).toBe(true)
    expect(status.running).toBe(true)
    expect(status.pid).toBe(42381)
  })

  test("status() returns loaded+not-running when no PID", async () => {
    const { runner } = createMockRunner({
      "launchctl list pantry-prod": {
        stdout: `"Label" = "pantry-prod";`,
        stderr: "",
        exitCode: 0,
      },
    })
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    const status = await run(mgr.status("pantry-prod"))
    expect(status.loaded).toBe(true)
    expect(status.running).toBe(false)
    expect(status.pid).toBeNull()
  })

  test("status() returns not-loaded when launchctl exits non-zero", async () => {
    const { runner } = createMockRunner({
      "launchctl list pantry-prod": {
        stdout: "",
        stderr: "Could not find service",
        exitCode: 113,
      },
    })
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    const status = await run(mgr.status("pantry-prod"))
    expect(status.loaded).toBe(false)
    expect(status.running).toBe(false)
    expect(status.pid).toBeNull()
  })

  test("status() parses tabular format PID", async () => {
    const { runner } = createMockRunner({
      "launchctl list pantry-prod": {
        stdout: "12345\t0\tpantry-prod\n",
        stderr: "",
        exitCode: 0,
      },
    })
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    const status = await run(mgr.status("pantry-prod"))
    expect(status.pid).toBe(12345)
    expect(status.running).toBe(true)
  })

  test("backup() copies plist to ~/.rig/launchd/ with timestamp", async () => {
    const { runner } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    // Install first so plist exists
    await run(mgr.install(sampleConfig))

    const backupPath = await run(mgr.backup(sampleConfig.label))

    expect(backupPath).toContain(join(tmpDir, ".rig", "launchd"))
    expect(backupPath).toContain("pantry-prod-backup-")
    expect(backupPath).toEndWith(".plist")

    // Backup content should match
    const original = await readFile(plistPath(sampleConfig.label, tmpDir), "utf-8")
    const backup = await readFile(backupPath, "utf-8")
    expect(backup).toBe(original)
  })
})
