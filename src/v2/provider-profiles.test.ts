import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import {
  V2ProviderProfileContext,
  V2ProviderProfileLive,
  v2ProviderProfileFromName,
} from "./provider-profiles.js"

describe("GIVEN v2 provider profiles WHEN selected through Effect services THEN behavior is covered", () => {
  test("GIVEN default profile WHEN inspected THEN concrete default provider families are named", () => {
    expect(v2ProviderProfileFromName("default")).toMatchObject({
      name: "default",
      processSupervisor: "rigd",
      proxyRouter: "caddy",
      scm: "local-git",
      workspaceMaterializer: "git-worktree",
      healthChecker: "native",
    })
  })

  test("GIVEN stub profile WHEN provided as a layer THEN v2 code can inspect selected provider families", async () => {
    const profile = await Effect.runPromise(
      Effect.gen(function* () {
        const profiles = yield* V2ProviderProfileContext
        return yield* profiles.current
      }).pipe(Effect.provide(V2ProviderProfileLive("stub"))),
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
