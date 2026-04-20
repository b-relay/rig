import { describe, expect, test } from "bun:test"
import { Effect } from "effect-v4"

import { decodeV2ProjectConfig, decodeV2StatusInput } from "./config.js"

describe("GIVEN v2 Effect Schema validation WHEN decoding representative inputs THEN behavior is covered", () => {
  test("GIVEN a valid v2 project config WHEN decoding THEN managed and installed components are accepted", async () => {
    const result = await Effect.runPromise(
      decodeV2ProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "bun run start",
            port: 3070,
            health: "http://127.0.0.1:3070/health",
          },
          cli: {
            mode: "installed",
            entrypoint: "src/index.ts",
            build: "bun run build",
          },
        },
        local: {
          command: "bun run dev",
          health: "http://127.0.0.1:5173",
        },
      }),
    )

    expect(result.name).toBe("pantry")
    expect(result.components.web?.mode).toBe("managed")
    expect(result.components.cli?.mode).toBe("installed")
  })

  test("GIVEN a health check targeting 0.0.0.0 WHEN decoding THEN schema validation returns a tagged error", async () => {
    const error = await Effect.runPromise(
      decodeV2ProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "bun run start",
            health: "http://0.0.0.0:3070/health",
          },
        },
      }).pipe(Effect.flip),
    )

    expect(error._tag).toBe("V2ConfigValidationError")
    expect(error.message).toBe("Invalid v2 project config.")
    expect(String(error.details?.cause)).toContain("0.0.0.0")
  })

  test("GIVEN invalid rig2 status input WHEN decoding THEN project validation fails through Effect Schema", async () => {
    const error = await Effect.runPromise(
      decodeV2StatusInput({
        project: "../pantry",
        stateRoot: "/tmp/rig-v2",
      }).pipe(Effect.flip),
    )

    expect(error._tag).toBe("V2ConfigValidationError")
    expect(error.message).toBe("Invalid rig2 status input.")
  })
})
