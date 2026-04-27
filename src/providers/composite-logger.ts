import { Context, Effect, Layer, Scope } from "effect-v3"

import { Logger, type Logger as LoggerService } from "../interfaces/logger.js"
import type { RigError } from "../schema/errors.js"

export class CompositeLogger implements LoggerService {
  constructor(private readonly loggers: readonly LoggerService[]) {}

  info(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return Effect.all(
      this.loggers.map((logger) => logger.info(message, details)),
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid)
  }

  warn(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return Effect.all(
      this.loggers.map((logger) => logger.warn(message, details)),
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid)
  }

  error(structured: RigError): Effect.Effect<void> {
    return Effect.all(
      this.loggers.map((logger) => logger.error(structured)),
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid)
  }

  success(message: string, details?: Record<string, unknown>): Effect.Effect<void> {
    return Effect.all(
      this.loggers.map((logger) => logger.success(message, details)),
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid)
  }

  table(rows: readonly Record<string, unknown>[]): Effect.Effect<void> {
    return Effect.all(
      this.loggers.map((logger) => logger.table(rows)),
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid)
  }
}

export const makeCompositeLoggerLayer = (...loggers: LoggerService[]): Layer.Layer<Logger> =>
  Layer.succeed(Logger, new CompositeLogger(loggers))

export const compositeLoggerLayer = (...layers: Layer.Layer<Logger>[]): Layer.Layer<Logger> =>
  Layer.scoped(
    Logger,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const instances = yield* Effect.all(
        layers.map((layer) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.map((context) => Context.get(context, Logger)),
          ),
        ),
        { concurrency: "unbounded" },
      )
      return new CompositeLogger(instances)
    }),
  )

export const CompositeLoggerLive = (...layers: Layer.Layer<Logger>[]): Layer.Layer<Logger> =>
  compositeLoggerLayer(...layers)
