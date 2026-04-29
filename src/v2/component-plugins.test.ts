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
})
