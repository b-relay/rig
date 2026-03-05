import { Effect, Layer } from "effect"

import {
  PortChecker,
  type PortChecker as PortCheckerService,
} from "../interfaces/port-checker.js"
import { PortConflictError, ServiceRunnerError } from "../schema/errors.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const lookupPortPid = (port: number) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn(["lsof", "-ti", `:${port}`, "-sTCP:LISTEN"], {
        stdout: "pipe",
        stderr: "pipe",
      })

      const [stdout, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ])

      if (exitCode !== 0) {
        return null
      }

      const firstLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0)

      if (!firstLine) {
        return null
      }

      const parsed = Number.parseInt(firstLine, 10)
      return Number.isFinite(parsed) ? parsed : null
    },
    catch: () => null,
  })

// ── Implementation ──────────────────────────────────────────────────────────

class BunPortChecker implements PortCheckerService {
  check(port: number, service: string) {
    return Effect.try({
      try: () => {
        const server = Bun.listen({
          hostname: "127.0.0.1",
          port,
          socket: { data() {} },
        })
        server.stop(true)
      },
      catch: (cause) => cause as { readonly code?: string },
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.gen(function* () {
          if (cause?.code === "EADDRINUSE") {
            const existingPid = yield* lookupPortPid(port).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            )

            return yield* Effect.fail(
              new PortConflictError(
                port,
                service,
                existingPid,
                `Port ${port} is already in use and blocks service '${service}'.`,
                `Stop the process using 127.0.0.1:${port}${existingPid ? ` (pid ${existingPid})` : ""}, or change '${service}' to a different port.`,
              ),
            )
          }

          return yield* Effect.fail(
            new ServiceRunnerError(
              "start",
              service,
              `Failed to verify availability of 127.0.0.1:${port}: ${causeMessage(cause)}`,
              `Check local network permissions and retry starting '${service}'.`,
            ),
          )
        }),
      ),
    )
  }
}

// ── Layer ───────────────────────────────────────────────────────────────────

export const BunPortCheckerLive = Layer.succeed(PortChecker, new BunPortChecker())
