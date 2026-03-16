import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  rigBinRoot,
  rigRegistryPath,
  rigRoot,
  rigVersionHistoryPath,
  rigVersionsRoot,
  rigWorkspacesRoot,
} from "./rig-paths.js"

const PREVIOUS_RIG_ROOT = process.env.RIG_ROOT

afterEach(() => {
  if (PREVIOUS_RIG_ROOT === undefined) {
    delete process.env.RIG_ROOT
  } else {
    process.env.RIG_ROOT = PREVIOUS_RIG_ROOT
  }
})

describe("GIVEN suite context WHEN rig path helpers resolve locations THEN behavior is covered", () => {
  test("GIVEN no RIG_ROOT WHEN helpers resolve THEN they default under ~/.rig", () => {
    delete process.env.RIG_ROOT

    expect(rigRoot()).toBe(join(homedir(), ".rig"))
    expect(rigRegistryPath()).toBe(join(homedir(), ".rig", "registry.json"))
    expect(rigWorkspacesRoot()).toBe(join(homedir(), ".rig", "workspaces"))
    expect(rigVersionsRoot()).toBe(join(homedir(), ".rig", "versions"))
    expect(rigVersionHistoryPath("pantry")).toBe(join(homedir(), ".rig", "versions", "pantry.json"))
    expect(rigBinRoot()).toBe(join(homedir(), ".rig", "bin"))
  })

  test("GIVEN RIG_ROOT is set WHEN helpers resolve THEN it overrides the default root", () => {
    process.env.RIG_ROOT = "/tmp/rig-custom-root"

    expect(rigRoot()).toBe("/tmp/rig-custom-root")
    expect(rigRegistryPath()).toBe("/tmp/rig-custom-root/registry.json")
    expect(rigWorkspacesRoot()).toBe("/tmp/rig-custom-root/workspaces")
    expect(rigVersionsRoot()).toBe("/tmp/rig-custom-root/versions")
    expect(rigVersionHistoryPath("pantry")).toBe("/tmp/rig-custom-root/versions/pantry.json")
    expect(rigBinRoot()).toBe("/tmp/rig-custom-root/bin")
  })
})
