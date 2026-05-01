import { join } from "node:path"
import { Effect } from "effect"

import type { RigDeploymentRecord } from "../deployments.js"
import {
  platformAppendFileString,
  platformMakeDirectory,
} from "../effect-platform.js"
import { RigRuntimeError } from "../errors.js"
import type {
  RigProviderPlugin,
  RigProviderPluginForFamily,
} from "../provider-contracts.js"

export interface RigStructuredLogEventTransportInput {
  readonly deployment: RigDeploymentRecord
  readonly event: string
  readonly component?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface RigStructuredLogEventTransportAdapter {
  readonly append: (
    input: RigStructuredLogEventTransportInput,
    selected: RigProviderPluginForFamily<"event-transport">,
  ) => Effect.Effect<string, RigRuntimeError>
}

export const structuredLogEventTransportProvider = {
  id: "structured-log-file",
  family: "event-transport",
  source: "first-party",
  displayName: "Structured Log File",
  capabilities: ["append-only-events", "doctor-readable"],
} satisfies RigProviderPlugin

export const createStructuredLogEventTransportAdapter = (): RigStructuredLogEventTransportAdapter => {
  const append = (
    input: RigStructuredLogEventTransportInput,
    selected: RigProviderPluginForFamily<"event-transport">,
  ): Effect.Effect<string, RigRuntimeError> => {
    const logPath = join(input.deployment.logRoot, "events.jsonl")
    const entry = {
      timestamp: new Date().toISOString(),
      event: input.event,
      project: input.deployment.project,
      kind: input.deployment.kind,
      deployment: input.deployment.name,
      ...(input.component ? { component: input.component } : {}),
      ...(input.details ? { details: input.details } : {}),
    }

    return Effect.gen(function* () {
      yield* platformMakeDirectory(input.deployment.logRoot)
      yield* platformAppendFileString(logPath, `${JSON.stringify(entry)}\n`)
      return `${selected.family}:${selected.id}:append:${input.event}${input.component ? `:${input.component}` : ""}`
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof RigRuntimeError
          ? cause
          : new RigRuntimeError(
            "Unable to append rig runtime event.",
            "Ensure the deployment log root is writable before retrying the runtime action.",
            {
              providerId: selected.id,
              logPath,
              event: input.event,
              ...(input.component ? { component: input.component } : {}),
              cause: cause instanceof Error ? cause.message : String(cause),
            },
          ),
      ),
    )
  }

  return { append }
}
