import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { rigRoot, rigWorkspacesRoot } from "../core/rig-paths.js"
import {
  RIG_V2_LAUNCHD_LABEL_PREFIX,
  RIG_V2_NAMESPACE,
  rigV2BinPath,
  rigV2BinRoot,
  rigV2LaunchdLabel,
  rigV2LogsRoot,
  rigV2ProjectNamespace,
  rigV2Root,
  rigV2RuntimeRoot,
  rigV2WorkspacesRoot,
} from "./paths.js"

const PREVIOUS_RIG_V2_ROOT = process.env.RIG_V2_ROOT
const PREVIOUS_RIG_ROOT = process.env.RIG_ROOT

afterEach(() => {
  if (PREVIOUS_RIG_V2_ROOT === undefined) {
    delete process.env.RIG_V2_ROOT
  } else {
    process.env.RIG_V2_ROOT = PREVIOUS_RIG_V2_ROOT
  }

  if (PREVIOUS_RIG_ROOT === undefined) {
    delete process.env.RIG_ROOT
  } else {
    process.env.RIG_ROOT = PREVIOUS_RIG_ROOT
  }
})

describe("GIVEN v2 path helpers WHEN resolving isolated state THEN behavior is covered", () => {
  test("GIVEN no override WHEN v2 paths resolve THEN they default under ~/.rig-v2 and do not collide with v1", () => {
    delete process.env.RIG_ROOT
    delete process.env.RIG_V2_ROOT

    expect(rigRoot()).toBe(join(homedir(), ".rig"))
    expect(rigV2Root()).toBe(join(homedir(), ".rig-v2"))
    expect(rigV2WorkspacesRoot()).toBe(join(homedir(), ".rig-v2", "workspaces"))
    expect(rigV2LogsRoot()).toBe(join(homedir(), ".rig-v2", "logs"))
    expect(rigV2RuntimeRoot()).toBe(join(homedir(), ".rig-v2", "runtime"))
    expect(rigV2BinRoot()).toBe(join(homedir(), ".rig-v2", "bin"))
    expect(rigV2BinPath("pantry")).toBe(join(homedir(), ".rig-v2", "bin", "pantry"))
    expect(rigV2WorkspacesRoot()).not.toBe(rigWorkspacesRoot())
  })

  test("GIVEN RIG_V2_ROOT override WHEN paths resolve THEN only v2 state uses the override", () => {
    process.env.RIG_ROOT = "/tmp/rig-v1"
    process.env.RIG_V2_ROOT = "/tmp/rig-v2"

    expect(rigRoot()).toBe("/tmp/rig-v1")
    expect(rigV2Root()).toBe("/tmp/rig-v2")
    expect(rigV2WorkspacesRoot()).toBe("/tmp/rig-v2/workspaces")
    expect(rigV2LogsRoot()).toBe("/tmp/rig-v2/logs")
  })

  test("GIVEN project names WHEN namespaces are built THEN v2 labels are isolated", () => {
    expect(RIG_V2_NAMESPACE).toBe("rig.v2")
    expect(RIG_V2_LAUNCHD_LABEL_PREFIX).toBe("com.b-relay.rig2")
    expect(rigV2ProjectNamespace("pantry")).toBe("rig.v2.pantry")
    expect(rigV2LaunchdLabel("pantry", "live")).toBe("com.b-relay.rig2.pantry.live")
  })
})
