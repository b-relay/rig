import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { getuid } from "node:process"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { rigLaunchdBackupRoot } from "../core/rig-paths.js"
import { LaunchdManager, generatePlist, plistPath } from "./launchd.js"
import type { DaemonConfig } from "../interfaces/process-manager.js"

const GUI_DOMAIN = `gui/${getuid!()}`

// ── Test helpers ────────────────────────────────────────────────────────────

const sampleConfig: DaemonConfig = {
  label: "pantry-prod",
  command: "/Users/clay/.rig/bin/rig",
  args: ["start", "pantry", "prod", "--foreground"],
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
const PREVIOUS_RIG_ROOT = process.env.RIG_ROOT

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "rig-launchd-test-"))
  process.env.RIG_ROOT = join(tmpDir, ".rig-root")
})

afterEach(async () => {
  if (PREVIOUS_RIG_ROOT === undefined) {
    delete process.env.RIG_ROOT
  } else {
    process.env.RIG_ROOT = PREVIOUS_RIG_ROOT
  }
  await rm(tmpDir, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

// ── Tests ───────────────────────────────────────────────────────────────────

describe("GIVEN suite context WHEN generatePlist THEN behavior is covered", () => {
  test("GIVEN test setup WHEN generates valid plist XML with all config fields THEN expected behavior is observed", () => {
    const xml = generatePlist(sampleConfig)

    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain("<key>Label</key>")
    expect(xml).toContain("<string>pantry-prod</string>")
    expect(xml).toContain("<key>ProgramArguments</key>")
    expect(xml).toContain("<string>/Users/clay/.rig/bin/rig</string>")
    expect(xml).toContain("<string>start</string>")
    expect(xml).toContain("<string>pantry</string>")
    expect(xml).toContain("<string>prod</string>")
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

  test("GIVEN test setup WHEN generates KeepAlive false when disabled THEN expected behavior is observed", () => {
    const config = { ...sampleConfig, keepAlive: false }
    const xml = generatePlist(config)
    expect(xml).toContain("<false/>")
    expect(xml).not.toContain("<true/>")
  })

  test("GIVEN test setup WHEN omits EnvironmentVariables dict when empty THEN expected behavior is observed", () => {
    const config = { ...sampleConfig, envVars: {} }
    const xml = generatePlist(config)
    expect(xml).not.toContain("<key>EnvironmentVariables</key>")
  })

  test("GIVEN test setup WHEN escapes XML special characters THEN expected behavior is observed", () => {
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

describe("GIVEN suite context WHEN plistPath THEN behavior is covered", () => {
  test("GIVEN test setup WHEN derives correct path from label THEN expected behavior is observed", () => {
    const path = plistPath("pantry-prod", "/Users/clay")
    expect(path).toBe("/Users/clay/Library/LaunchAgents/com.b-relay.rig.pantry-prod.plist")
  })

  test("GIVEN test setup WHEN uses custom home directory THEN expected behavior is observed", () => {
    const path = plistPath("myapp-dev", "/tmp/fakehome")
    expect(path).toBe("/tmp/fakehome/Library/LaunchAgents/com.b-relay.rig.myapp-dev.plist")
  })
})

describe("GIVEN suite context WHEN LaunchdManager THEN behavior is covered", () => {
  test("GIVEN test setup WHEN install() writes plist and calls launchctl bootstrap THEN expected behavior is observed", async () => {
    const { runner, captured } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    await run(mgr.install(sampleConfig))

    // Verify plist was written
    const expectedPath = plistPath(sampleConfig.label, tmpDir)
    const content = await readFile(expectedPath, "utf-8")
    expect(content).toContain("<key>Label</key>")
    expect(content).toContain("<string>pantry-prod</string>")

    // Verify launchctl bootout (pre-clean) then bootstrap was called
    expect(captured).toHaveLength(2)
    expect(captured[0].args).toEqual(["launchctl", "bootout", `${GUI_DOMAIN}/${sampleConfig.label}`])
    expect(captured[1].args).toEqual(["launchctl", "bootstrap", GUI_DOMAIN, expectedPath])
  })

  test("GIVEN test setup WHEN install() fails with ProcessError when launchctl bootstrap fails THEN expected behavior is observed", async () => {
    const { runner } = createMockRunner({
      [`launchctl bootstrap ${GUI_DOMAIN} ${plistPath(sampleConfig.label, tmpDir)}`]: {
        stdout: "",
        stderr: "Could not bootstrap service",
        exitCode: 1,
      },
    })
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    const result = await Effect.runPromiseExit(mgr.install(sampleConfig))
    expect(result._tag).toBe("Failure")
  })

  test("GIVEN test setup WHEN uninstall() calls launchctl bootout and deletes plist THEN expected behavior is observed", async () => {
    const { runner, captured } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    // First install so the file exists
    await run(mgr.install(sampleConfig))

    // Now uninstall
    await run(mgr.uninstall(sampleConfig.label))

    // Should have called: bootout+bootstrap (install), bootout (uninstall)
    expect(captured).toHaveLength(3)
    expect(captured[2].args).toEqual([
      "launchctl",
      "bootout",
      `${GUI_DOMAIN}/${sampleConfig.label}`,
    ])

    // File should be deleted
    const file = Bun.file(plistPath(sampleConfig.label, tmpDir))
    expect(await file.exists()).toBe(false)
  })

  test("GIVEN test setup WHEN uninstall() succeeds even if plist file is already gone THEN expected behavior is observed", async () => {
    const { runner } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    // Don't install — no plist file exists. Bootout returns "not loaded" style error.
    const responses: Record<string, { stdout: string; stderr: string; exitCode: number }> = {}
    responses[`launchctl bootout ${GUI_DOMAIN}/${sampleConfig.label}`] = {
      stdout: "",
      stderr: "No such process",
      exitCode: 3,
    }
    const { runner: runner2 } = createMockRunner(responses)
    const mgr2 = new LaunchdManager({ runCommand: runner2, home: tmpDir })

    // Should not throw — idempotent uninstall
    await run(mgr2.uninstall(sampleConfig.label))
  })

  test("GIVEN test setup WHEN install() rejects invalid label characters THEN expected behavior is observed", async () => {
    const { runner } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    const badConfig = { ...sampleConfig, label: "../escape" }
    const result = await Effect.runPromiseExit(mgr.install(badConfig))
    expect(result._tag).toBe("Failure")
  })

  test("GIVEN test setup WHEN start() calls launchctl start with label THEN expected behavior is observed", async () => {
    const { runner, captured } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    await run(mgr.start("pantry-prod"))

    expect(captured).toHaveLength(1)
    expect(captured[0].args).toEqual(["launchctl", "start", "pantry-prod"])
  })

  test("GIVEN test setup WHEN stop() calls launchctl stop with label THEN expected behavior is observed", async () => {
    const { runner, captured } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    await run(mgr.stop("pantry-prod"))

    expect(captured).toHaveLength(1)
    expect(captured[0].args).toEqual(["launchctl", "stop", "pantry-prod"])
  })

  test("GIVEN test setup WHEN status() returns loaded+running with PID when service is running THEN expected behavior is observed", async () => {
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

  test("GIVEN test setup WHEN status() returns loaded+not-running when no PID THEN expected behavior is observed", async () => {
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

  test("GIVEN test setup WHEN status() returns not-loaded when launchctl exits non-zero THEN expected behavior is observed", async () => {
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

  test("GIVEN test setup WHEN status() parses tabular format PID THEN expected behavior is observed", async () => {
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

  test("GIVEN test setup WHEN backup() copies plist to ~/.rig/launchd/ with timestamp THEN expected behavior is observed", async () => {
    const { runner } = createMockRunner()
    const mgr = new LaunchdManager({ runCommand: runner, home: tmpDir })

    // Install first so plist exists
    await run(mgr.install(sampleConfig))

    const backupPath = await run(mgr.backup(sampleConfig.label))

    expect(backupPath).toContain(rigLaunchdBackupRoot())
    expect(backupPath).toContain("pantry-prod-backup-")
    expect(backupPath).toEndWith(".plist")

    // Backup content should match
    const original = await readFile(plistPath(sampleConfig.label, tmpDir), "utf-8")
    const backup = await readFile(backupPath, "utf-8")
    expect(backup).toBe(original)
  })
})
