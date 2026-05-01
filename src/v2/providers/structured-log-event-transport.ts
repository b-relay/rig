import { join } from "node:path"
import { Effect } from "effect"

import type { V2DeploymentRecord } from "../deployments.js"
import {
  platformAppendFileString,
  platformMakeDirectory,
} from "../effect-platform.js"
import { V2RuntimeError } from "../errors.js"
import type {
  V2ProviderPlugin,
  V2ProviderPluginForFamily,
} from "../provider-contracts.js"

export interface V2StructuredLogEventTransportInput {
  readonly deployment: V2DeploymentRecord
  readonly event: string
  readonly component?: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface V2StructuredLogEventTransportAdapter {
  readonly append: (
    input: V2StructuredLogEventTransportInput,
    selected: V2ProviderPluginForFamily<"event-transport">,
  ) => Effect.Effect<string, V2RuntimeError>
}

export const structuredLogEventTransportProvider = {
  id: "structured-log-file",
  family: "event-transport",
  source: "first-party",
  displayName: "Structured Log File",
  capabilities: ["append-only-events", "doctor-readable"],
} satisfies V2ProviderPlugin

export const createStructuredLogEventTransportAdapter = (): V2StructuredLogEventTransportAdapter => {
  const append = (
    input: V2StructuredLogEventTransportInput,
    selected: V2ProviderPluginForFamily<"event-transport">,
  ): Effect.Effect<string, V2RuntimeError> => {
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
        cause instanceof V2RuntimeError
          ? cause
          : new V2RuntimeError(
            "Unable to append v2 runtime event.",
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
