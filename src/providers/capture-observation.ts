import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import type { ProcessObservation } from "./contracts";
import type { ProcessIdentityReader } from "./process-identity";
import { processLeasePath, processLeaseSchema } from "./process-lease";

const observationSchema = z.object({
  wrapperPid: z
    .number()
    .int()
    .positive()
    .describe("Capture wrapper process identifier."),
  wrapperIdentity: z
    .string()
    .length(64)
    .describe("Capture wrapper process birth identity."),
  observedAt: z
    .number()
    .finite()
    .describe("Unix milliseconds when the child was observed."),
  applicationIdentity: z
    .string()
    .length(64)
    .optional()
    .describe("Running application process birth identity."),
  observation: z
    .object({
      state: z
        .enum(["running", "stopped", "unknown"])
        .describe("Current application process state."),
      pid: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Application process identifier, never the wrapper PID."),
      exitCode: z
        .number()
        .int()
        .optional()
        .describe("Last application exit code."),
      signal: z
        .string()
        .optional()
        .describe("Signal that ended the application, when one did."),
      incarnation: z
        .string()
        .optional()
        .describe("The start that produced the observed application process."),
      reason: z
        .string()
        .optional()
        .describe("Safe explanation of uncertain application state."),
    })
    .describe("Application observation owned by the capture supervisor."),
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
      JSON.parse(
        await readFile(`${request.requestPath}.observation.json`, "utf8"),
      ),
    );
    // Freshness is judged at read time; identity inspections that follow may be slow on a loaded Host.
    const age = request.now() - evidence.observedAt;
    if (age < 0 || age > FRESHNESS_MS) return unknown;
    if (
      evidence.wrapperPid !== request.wrapperPid ||
      (await request.inspect(request.wrapperPid)) !== evidence.wrapperIdentity
    )
      return unknown;
    const observation = evidence.observation;
    if (
      observation.state === "running" &&
      (!observation.pid ||
        !evidence.applicationIdentity ||
        (await request.inspect(observation.pid)) !==
          evidence.applicationIdentity)
    )
      return unknown;
    if (request.signal?.aborted) return unknown;
    return observation;
  } catch {
    return unknown;
  }
}

/** What a supervisor reports about the application of a capture wrapper that is gone: nothing when that application is gone
 * too (or none was ever recorded), and an `unknown` observation when it may still run. The application is known from the
 * wrapper's last observation and from the lease the wrapper's own supervisor writes, beside the request, as soon as it spawns
 * the application: a wrapper killed before its first observation still leaves that lease. It still runs while its pid has the
 * recorded birth identity, or, once that leader is gone, while its process group has members, as the wrapper's supervisor
 * itself judges ownership. A reused pid never counts as the application. A record that exists but cannot be read, and a
 * probe that fails, leave the application uncertain rather than gone. Freshness does not matter here: the wrapper's last
 * word is exactly what is in question. */
export async function survivingApplication(request: {
  requestPath: string;
  key: string;
  inspect: ProcessIdentityReader;
  groupExists: (pid: number) => Promise<boolean>;
}): Promise<ProcessObservation | undefined> {
  const uncertain = (subject: string): ProcessObservation => ({
    state: "unknown",
    reason: `The capture wrapper is gone and whether ${subject} still runs could not be verified.`,
  });
  const observed = await observedApplication(request.requestPath);
  const leased = await leasedApplication(
    dirname(request.requestPath),
    request.key,
  );
  if (observed === "unreadable" || leased === "unreadable")
    return uncertain("its application");
  for (const { pid, identity: expected } of [...observed, ...leased]) {
    let running: boolean;
    try {
      const identity = await request.inspect(pid);
      // A pid with another identity was reused, so a group by that id is not the application's.
      running =
        identity === expected ||
        (identity === undefined && (await request.groupExists(pid)));
    } catch {
      return uncertain(`its application (pid ${pid})`);
    }
    if (running)
      return {
        state: "unknown",
        reason: `The application (pid ${pid}, or its process group) is still running without its capture wrapper, so Rig neither stops it nor starts another. End that process group, then run rig up.`,
      };
  }
  return undefined;
}
type RecordedApplication = { pid: number; identity: string };
/** The running application the wrapper's last observation names, with its birth identity; none without an observation or
 * when it names none, and `unreadable` when the observation exists but cannot be read. */
async function observedApplication(
  requestPath: string,
): Promise<RecordedApplication[] | "unreadable"> {
  const saved = await readRecord(`${requestPath}.observation.json`);
  if (saved.kind !== "read") return saved.kind === "absent" ? [] : saved.kind;
  const parsed = observationSchema.safeParse(saved.content);
  if (!parsed.success) return "unreadable";
  const { observation, applicationIdentity } = parsed.data;
  return observation.state === "running" &&
    observation.pid &&
    applicationIdentity
    ? [{ pid: observation.pid, identity: applicationIdentity }]
    : [];
}
/** The application the wrapper's own supervisor, whose state lives in `stateRoot`, leased for `key`; none without a lease,
 * and `unreadable` when the lease exists but cannot be read. */
async function leasedApplication(
  stateRoot: string,
  key: string,
): Promise<RecordedApplication[] | "unreadable"> {
  const saved = await readRecord(processLeasePath(stateRoot, key));
  if (saved.kind !== "read") return saved.kind === "absent" ? [] : saved.kind;
  const parsed = processLeaseSchema.safeParse(saved.content);
  if (!parsed.success || parsed.data.key !== key) return "unreadable";
  return [{ pid: parsed.data.pid, identity: parsed.data.identity }];
}
/** A JSON record's content: `absent` when there is none, `unreadable` when it exists but cannot be read or parsed. */
async function readRecord(
  path: string,
): Promise<
  { kind: "read"; content: unknown } | { kind: "absent" | "unreadable" }
> {
  try {
    return { kind: "read", content: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    return {
      kind:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "absent"
          : "unreadable",
    };
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
