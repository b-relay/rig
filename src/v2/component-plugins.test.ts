import { describe, expect, test } from "bun:test"

import { resolveV2ComponentPlugin } from "./component-plugins.js"

describe("GIVEN v2 component plugins WHEN resolving plugin-backed components THEN behavior is covered", () => {
  test("GIVEN SQLite uses config WHEN resolved THEN it exposes prepared metadata and interpolation properties", () => {
    const resolved = resolveV2ComponentPlugin({
      uses: "sqlite",
      componentName: "db",
      dataRoot: "/tmp/rig-v2/data/pantry/local",
      interpolate: (value) => value,
    })

    expect(resolved).toEqual({
      preparedComponents: [
        {
          name: "db",
          uses: "sqlite",
          path: "/tmp/rig-v2/data/pantry/local/sqlite/db.sqlite",
        },
      ],
      properties: {
        path: "/tmp/rig-v2/data/pantry/local/sqlite/db.sqlite",
      },
    })
  })

  test("GIVEN SQLite path override WHEN resolved THEN the override is interpolated", () => {
    const resolved = resolveV2ComponentPlugin({
      uses: "sqlite",
      componentName: "db",
      dataRoot: "/tmp/rig-v2/data/pantry/live",
      configuredPath: "${dataRoot}/custom/main.sqlite",
      interpolate: (value) => value.replace("${dataRoot}", "/tmp/rig-v2/data/pantry/live"),
    })

    expect(resolved.properties.path).toBe("/tmp/rig-v2/data/pantry/live/custom/main.sqlite")
  })

  test("GIVEN Convex uses config WHEN resolved THEN it expands to a managed service with defaults", () => {
    const resolved = resolveV2ComponentPlugin({
      uses: "convex",
      componentName: "convex",
      dataRoot: "/tmp/rig-v2/data/pantry/local",
      workspacePath: "/tmp/rig-v2/workspaces/pantry/local",
      port: 3210,
      sitePort: 3211,
      dependsOn: ["postgres"],
      interpolate: (value) => value,
    })

    expect(resolved).toEqual({
      preparedComponents: [
        {
          name: "convex",
          uses: "convex",
          stateDir: "/tmp/rig-v2/workspaces/pantry/local/.convex/local/default",
        },
      ],
      managedComponents: [
        {
          name: "convex",
          command: "bunx convex dev --local --local-cloud-port 3210 --local-site-port 3211",
          port: 3210,
          health: "http://127.0.0.1:3210/instance_name",
          readyTimeout: 60,
          dependsOn: ["postgres"],
        },
      ],
      properties: {
        port: 3210,
        sitePort: 3211,
        stateDir: "/tmp/rig-v2/workspaces/pantry/local/.convex/local/default",
        url: "http://127.0.0.1:3210",
        siteUrl: "http://127.0.0.1:3211",
      },
    })
  })
})
