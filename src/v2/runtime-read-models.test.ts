import { describe, expect, test } from "bun:test"

import { deriveV2RuntimeLogWindow, deriveV2RuntimeWebReadModel } from "./runtime-read-models.js"
import type { V2RigdPersistentState } from "./rigd-state.js"

const emptyState = (): V2RigdPersistentState => ({
  version: 1,
  events: [],
  receipts: [],
  healthSummaries: [],
  providerObservations: [],
  portReservations: [],
  deploymentSnapshots: [],
  desiredDeployments: [],
  managedServiceFailures: [],
})

describe("GIVEN v2 runtime read models WHEN deriving from journal evidence THEN CLI and web views share one projection", () => {
  test("GIVEN empty journal evidence WHEN read model is derived THEN stale empty state is returned", () => {
    const model = deriveV2RuntimeWebReadModel(emptyState())

    expect(model).toMatchObject({
      projects: [],
      deployments: [],
      health: {
        rigd: {
          status: "stale",
        },
        providers: [],
      },
    })
  })

  test("GIVEN multiple projects generated deployments stale providers and component ports WHEN read model is derived THEN rows come from persisted evidence", () => {
    const state: V2RigdPersistentState = {
      ...emptyState(),
      events: [
        {
          timestamp: "2026-05-01T00:00:00.000Z",
          event: "rigd.lifecycle.accepted",
          project: "worker",
          lane: "local",
        },
      ],
      healthSummaries: [
        {
          service: "rigd",
          status: "running",
          checkedAt: "2026-05-01T00:00:01.000Z",
          providerProfile: "stub",
        },
      ],
      providerObservations: [
        {
          id: "launchd",
          family: "process-supervisor",
          status: "stale",
          observedAt: "2026-05-01T00:00:02.000Z",
          capabilities: ["restart-policy"],
        },
      ],
      deploymentSnapshots: [
        {
          project: "pantry",
          deployment: "feature-read-model",
          kind: "generated",
          observedAt: "2026-05-01T00:00:03.000Z",
          providerProfile: "stub",
        },
        {
          project: "api",
          deployment: "local",
          kind: "local",
          observedAt: "2026-05-01T00:00:04.000Z",
          providerProfile: "default",
        },
        {
          project: "pantry",
          deployment: "live",
          kind: "live",
          observedAt: "2026-05-01T00:00:05.000Z",
          providerProfile: "default",
        },
      ],
      portReservations: [
        {
          project: "pantry",
          deployment: "feature-read-model",
          component: "web",
          port: 3070,
          owner: "rigd",
          status: "reserved",
          observedAt: "2026-05-01T00:00:06.000Z",
        },
      ],
    }

    const model = deriveV2RuntimeWebReadModel(state)

    expect(model.projects.map((project) => project.name)).toEqual(["api", "pantry", "worker"])
    expect(model.deployments.map((deployment) => `${deployment.project}:${deployment.kind}:${deployment.name}`)).toEqual([
      "api:local:local",
      "pantry:live:live",
      "pantry:generated:feature-read-model",
    ])
    expect(model.health.rigd).toMatchObject({
      status: "running",
      checkedAt: "2026-05-01T00:00:01.000Z",
      providerProfile: "stub",
    })
    expect(model.health.providers).toEqual([
      {
        id: "launchd",
        family: "process-supervisor",
        status: "stale",
        observedAt: "2026-05-01T00:00:02.000Z",
      },
    ])
    expect(model.health.components).toEqual([
      {
        project: "pantry",
        deployment: "feature-read-model",
        component: "web",
        port: 3070,
        status: "reserved",
        observedAt: "2026-05-01T00:00:06.000Z",
      },
    ])
  })

  test("GIVEN persisted runtime events WHEN log windows are derived THEN filters and line bounds are shared", () => {
    const state: V2RigdPersistentState = {
      ...emptyState(),
      events: [
        {
          timestamp: "2026-05-01T00:00:00.000Z",
          event: "rigd.started",
        },
        {
          timestamp: "2026-05-01T00:00:00.000Z",
          event: "component.log",
          project: "pantry",
          lane: "local",
          component: "web",
          details: { line: "first" },
        },
        {
          timestamp: "2026-05-01T00:00:01.000Z",
          event: "component.log",
          project: "pantry",
          lane: "local",
          component: "web",
          details: { line: "second" },
        },
        {
          timestamp: "2026-05-01T00:00:02.000Z",
          event: "component.log",
          project: "pantry",
          lane: "live",
          component: "web",
          details: { line: "wrong-lane" },
        },
        {
          timestamp: "2026-05-01T00:00:03.000Z",
          event: "component.log",
          project: "api",
          lane: "local",
          component: "web",
          details: { line: "wrong-project" },
        },
      ],
    }

    const window = deriveV2RuntimeLogWindow(state, {
      project: "pantry",
      lane: "local",
      component: "web",
      lines: 1,
    })

    expect(window.map((entry) => entry.details?.line)).toEqual(["second"])
    expect(deriveV2RuntimeLogWindow(state, {
      project: "pantry",
      lines: 5,
      includeGlobal: true,
    }).map((entry) => entry.event)).toEqual([
      "rigd.started",
      "component.log",
      "component.log",
      "component.log",
    ])
  })
})
