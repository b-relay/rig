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
      port: 3210,
      dependsOn: ["postgres"],
      interpolate: (value) => value,
    })

    expect(resolved).toEqual({
      preparedComponents: [
        {
          name: "convex",
          uses: "convex",
          dataDir: "/tmp/rig-v2/data/pantry/local/convex/convex",
        },
      ],
      managedComponents: [
        {
          name: "convex",
          command: "bunx convex dev --host 127.0.0.1 --port 3210",
          port: 3210,
          health: "http://127.0.0.1:3210/version",
          readyTimeout: 60,
          dependsOn: ["postgres"],
        },
      ],
      properties: {
        dataDir: "/tmp/rig-v2/data/pantry/local/convex/convex",
        port: 3210,
        url: "http://127.0.0.1:3210",
      },
    })
  })
})
