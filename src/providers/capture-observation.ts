import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProcessObservation } from "./contracts";
import type { ProcessIdentityReader } from "./process-identity";

const observationSchema = z.object({
  wrapperPid: z.number().int().positive()
    .describe("Capture wrapper process identifier."),
  wrapperIdentity: z.string().length(64)
    .describe("Capture wrapper process birth identity."),
  observedAt: z.number().finite()
    .describe("Unix milliseconds when the child was observed."),
  applicationIdentity: z.string().length(64).optional()
    .describe("Running application process birth identity."),
  observation: z.object({
    state: z.enum(["running", "stopped", "unknown"])
      .describe("Current application process state."),
    pid: z.number().int().positive().optional()
      .describe("Application process identifier, never the wrapper PID."),
    exitCode: z.number().int().optional()
      .describe("Last application exit code."),
    restartPending: z.boolean().optional()
      .describe("Whether another application restart attempt is scheduled."),
    restartAt: z.number().finite().optional()
      .describe("Unix milliseconds of the next scheduled restart attempt."),
    reason: z.string().optional()
      .describe("Safe explanation of uncertain application state."),
  }).describe("Application observation owned by the capture supervisor."),
});
export type CaptureObservation = z.infer<typeof observationSchema>;

/** Capture's existing observation loop publishes a complete, atomic child snapshot. */
export async function writeCaptureObservation(
  requestPath: string,
  evidence: CaptureObservation,
): Promise<void> {
  const path = `${requestPath}.observation.json`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(evidence), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Evidence older than this at read time no longer describes the application; the wrapper republishes at least every 250 ms. */
const FRESHNESS_MS = 1000;
/** Only fresh evidence from the current launchd wrapper can describe its application. */
export async function readCaptureObservation(request: {
  requestPath: string;
  wrapperPid: number;
  inspect: ProcessIdentityReader;
  now: () => number;
  signal?: AbortSignal;
}): Promise<ProcessObservation> {
  const unknown: ProcessObservation = {
    state: "unknown",
    reason: "Current application ownership and state could not be verified.",
  };
  try {
    if (request.signal?.aborted) return unknown;
    const evidence = observationSchema.parse(
      JSON.parse(await readFile(`${request.requestPath}.observation.json`, "utf8")),
    );
    // Freshness is judged at read time; identity inspections that follow may be slow on a loaded Host.
    const age = request.now() - evidence.observedAt;
    if (age < 0 || age > FRESHNESS_MS) return unknown;
    if (
      evidence.wrapperPid !== request.wrapperPid ||
      await request.inspect(request.wrapperPid) !== evidence.wrapperIdentity
    ) return unknown;
    const observation = evidence.observation;
    if (
      observation.state === "running" &&
      (!observation.pid || !evidence.applicationIdentity ||
        await request.inspect(observation.pid) !== evidence.applicationIdentity)
    ) return unknown;
    if (request.signal?.aborted) return unknown;
    return observation;
  } catch {
    return unknown;
  }
}

/** Wraps a publisher so unchanged evidence is rewritten only once per heartbeat, while any change is published at once. */
export function throttledPublisher<Observation>(
  publish: (
    observation: Observation,
    applicationIdentity?: string,
  ) => Promise<void>,
  options: { heartbeatMs: number; now: () => number },
): (observation: Observation, applicationIdentity?: string) => Promise<void> {
  let last: { key: string; at: number } | undefined;
  return async (observation, applicationIdentity) => {
    const key = JSON.stringify([observation, applicationIdentity]);
    const at = options.now();
    if (last && last.key === key && at - last.at < options.heartbeatMs) return;
    await publish(observation, applicationIdentity);
    last = { key, at };
  };
}
