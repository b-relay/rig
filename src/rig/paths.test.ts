import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  RIG_LAUNCHD_LABEL_PREFIX,
  RIG_NAMESPACE,
  rigBinPath,
  rigBinRoot,
  rigLaunchdLabel,
  rigLogsRoot,
  rigProjectNamespace,
  rigRoot,
  rigRuntimeRoot,
  rigWorkspacesRoot,
} from "./paths.js"

const PREVIOUS_RIG_ROOT = process.env.RIG_ROOT

afterEach(() => {
  if (PREVIOUS_RIG_ROOT === undefined) {
    delete process.env.RIG_ROOT
  } else {
    process.env.RIG_ROOT = PREVIOUS_RIG_ROOT
  }
})

describe("GIVEN rig path helpers WHEN resolving isolated state THEN behavior is covered", () => {
  test("GIVEN no override WHEN rig paths resolve THEN they default under ~/.rig", () => {
    delete process.env.RIG_ROOT

    expect(rigRoot()).toBe(join(homedir(), ".rig"))
    expect(rigWorkspacesRoot()).toBe(join(homedir(), ".rig", "workspaces"))
    expect(rigLogsRoot()).toBe(join(homedir(), ".rig", "logs"))
    expect(rigRuntimeRoot()).toBe(join(homedir(), ".rig", "runtime"))
    expect(rigBinRoot()).toBe(join(homedir(), ".rig", "bin"))
    expect(rigBinPath("pantry")).toBe(join(homedir(), ".rig", "bin", "pantry"))
  })

  test("GIVEN RIG_ROOT override WHEN paths resolve THEN rig state uses the override", () => {
    process.env.RIG_ROOT = "/tmp/rig"

    expect(rigRoot()).toBe("/tmp/rig")
    expect(rigWorkspacesRoot()).toBe("/tmp/rig/workspaces")
    expect(rigLogsRoot()).toBe("/tmp/rig/logs")
  })

  test("GIVEN project names WHEN namespaces are built THEN rig labels are isolated", () => {
    expect(RIG_NAMESPACE).toBe("rig")
    expect(RIG_LAUNCHD_LABEL_PREFIX).toBe("com.b-relay.rig")
    expect(rigProjectNamespace("pantry")).toBe("rig.pantry")
    expect(rigLaunchdLabel("pantry", "live")).toBe("com.b-relay.rig.pantry.live")
  })
})
