import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { RigDoctor, RigDoctorLive, type RigDoctorCheckInput, type RigDoctorService } from "./doctor.js"

const runDoctor = <A, E = unknown>(effect: Effect.Effect<A, E, RigDoctorService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(RigDoctorLive)))

const passingInput = (): RigDoctorCheckInput => ({
  project: "pantry",
  deployment: "live",
  dependencies: [{ name: "bun", ok: true }],
  binaries: [{ path: "/usr/local/bin/bun", ok: true }],
  env: [{ name: "DATABASE_URL", ok: true }],
  hooks: [{ name: "preStart", ok: true }],
  healthChecks: [{ component: "web", target: "http://127.0.0.1:3070/health", ok: true, ownedByRig: true }],
  ports: [{ component: "web", port: 3070, available: true }],
  staleState: [{ name: "runtime-journal", ok: true }],
  providers: [{ name: "process-supervisor:rigd", ok: true, profile: "stub" }],
})

describe("GIVEN rig doctor and deploy preflight WHEN reliability checks run THEN behavior is covered", () => {
  test("GIVEN complete preflight input WHEN verifying THEN all deploy cutover categories are checked", async () => {
    const result = await runDoctor(
      Effect.gen(function* () {
        const doctor = yield* RigDoctor
        return yield* doctor.preflight(passingInput())
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.checkedCategories).toEqual([
      "dependencies",
      "binaries",
      "env",
      "hooks",
      "health",
      "ports",
      "stale-state",
      "providers",
    ])
    expect(result.failures).toEqual([])
  })

  test("GIVEN health check from another process WHEN verifying THEN preflight fails ownership validation", async () => {
    const input = passingInput()
    const result = await runDoctor(
      Effect.gen(function* () {
        const doctor = yield* RigDoctor
        return yield* doctor.preflight({
          ...input,
          healthChecks: [
            {
              component: "web",
              target: "http://127.0.0.1:3070/health",
              ok: true,
              ownedByRig: false,
              observedPid: 9001,
            },
          ],
        })
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.failures[0]).toMatchObject({
      category: "health",
      component: "web",
      reason: "health-ownership",
      details: {
        observedPid: 9001,
      },
    })
  })

  test("GIVEN port conflict WHEN verifying THEN process ownership details are actionable", async () => {
    const input = passingInput()
    const result = await runDoctor(
      Effect.gen(function* () {
        const doctor = yield* RigDoctor
        return yield* doctor.preflight({
          ...input,
          ports: [
            {
              component: "web",
              port: 3070,
              available: false,
              ownerPid: 1234,
              ownerCommand: "node server.js",
            },
          ],
        })
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.failures[0]).toMatchObject({
      category: "ports",
      component: "web",
      reason: "port-conflict",
      details: {
        port: 3070,
        ownerPid: 1234,
        ownerCommand: "node server.js",
      },
      hint: "Stop PID 1234 or move component 'web' to another port before cutover.",
    })
  })

  test("GIVEN doctor input WHEN reporting THEN path binary health port stale and provider categories are present", async () => {
    const report = await runDoctor(
      Effect.gen(function* () {
        const doctor = yield* RigDoctor
        return yield* doctor.report({
          project: "pantry",
          path: { ok: true, entries: ["/usr/local/bin"] },
          binaries: [{ path: "/usr/local/bin/rig", ok: true }],
          health: [{ component: "web", ok: true, ownedByRig: true }],
          ports: [{ component: "web", port: 3070, available: true }],
          staleState: [{ name: "runtime", ok: true }],
          providers: [{ name: "process", ok: true, profile: "stub" }],
        })
      }),
    )

    expect(report.categories.map((category) => category.category)).toEqual([
      "path",
      "binaries",
      "health",
      "ports",
      "stale-state",
      "providers",
    ])
    expect(report.ok).toBe(true)
  })

  test("GIVEN reconstruction evidence WHEN safe THEN bounded recovery plan is returned", async () => {
    const plan = await runDoctor(
      Effect.gen(function* () {
        const doctor = yield* RigDoctor
        return yield* doctor.reconstruct({
          project: "pantry",
          deployment: "feature-a",
          rigdAlive: true,
          providerStatePresent: true,
          deploymentInventoryPresent: true,
          gitRefPresent: true,
        })
      }),
    )

    expect(plan.safe).toBe(true)
    expect(plan.steps).toEqual([
      "read-rigd-runtime-state",
      "read-provider-state",
      "read-deployment-inventory",
      "verify-git-ref",
      "rewrite-minimum-runtime-state",
    ])
  })

  test("GIVEN reconstruction evidence WHEN unsafe THEN structured failure is returned", async () => {
    const error = await runDoctor(
      Effect.gen(function* () {
        const doctor = yield* RigDoctor
        return yield* doctor.reconstruct({
          project: "pantry",
          deployment: "feature-a",
          rigdAlive: false,
          providerStatePresent: true,
          deploymentInventoryPresent: false,
          gitRefPresent: true,
        }).pipe(Effect.flip)
      }),
    )

    expect(error._tag).toBe("RigRuntimeError")
    expect(error.details?.reason).toBe("unsafe-reconstruction")
  })
})
