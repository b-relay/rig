import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import {
  RigProviderProfileContext,
  RigProviderProfileLive,
  rigProviderProfileFromName,
} from "./provider-profiles.js"

describe("GIVEN rig provider profiles WHEN selected through Effect services THEN behavior is covered", () => {
  test("GIVEN default profile WHEN inspected THEN concrete default provider families are named", () => {
    expect(rigProviderProfileFromName("default")).toMatchObject({
      name: "default",
      processSupervisor: "rigd",
      proxyRouter: "caddy",
      scm: "local-git",
      workspaceMaterializer: "git-worktree",
      healthChecker: "native",
    })
  })

  test("GIVEN stub profile WHEN provided as a layer THEN rig code can inspect selected provider families", async () => {
    const profile = await Effect.runPromise(
      Effect.gen(function* () {
        const profiles = yield* RigProviderProfileContext
        return yield* profiles.current
      }).pipe(Effect.provide(RigProviderProfileLive("stub"))),
    )

    expect(profile).toMatchObject({
      name: "stub",
      processSupervisor: "stub",
      proxyRouter: "stub",
      scm: "stub",
      workspaceMaterializer: "stub",
      healthChecker: "stub",
    })
  })
})
