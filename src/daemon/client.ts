import {
  projectStatusSchema,
  type ProjectStatusReport,
  type StatusSelection,
} from "../domain/project-status";
import { z } from "zod";
import { RigError, cancelled } from "../domain/errors";
import { RIG_BUILD } from "../domain/version";
import {
  readResultSchemas,
  type DaemonAddress,
  type DaemonHealth,
  type RuntimeCommand,
} from "./protocol";

const healthSchema = z.object({
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  running: z.literal(true),
  version: z.string().min(1).optional(),
  dashboard: z.string().min(1).optional(),
  dashboardProblem: z.string().min(1).optional(),
});
const errorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    hint: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
/** rig only sends commands its own grammar accepts, so a daemon that rejects
 * one as invalid is running a different version. */
const versionSkew = (details: Record<string, unknown> | undefined) => {
  const rigd =
    typeof details?.version === "string" ? details.version : undefined;
  return new RigError(
    "DAEMON_PROTOCOL",
    `rig ${RIG_BUILD} sent a command that rigd ${rigd ?? "of an older version"} does not accept.`,
    "Run 'rigd install' to upgrade rigd to the same version as rig.",
    { rig: RIG_BUILD, ...(rigd ? { rigd } : {}) },
  );
};
const resultSchema = z
  .object({ result: z.unknown() })
  .refine((value) => Object.hasOwn(value, "result"));
/** Only reads and the health probe carry a deadline; rigd answers them without queueing, so a late answer means a busy daemon, not a queued operation. */
const deadlineExpired = (
  deadline: ReadDeadline,
  operationId: string | undefined,
) =>
  new RigError(
    "DAEMON_TIMEOUT",
    `rigd did not answer the ${deadline.subject} within ${deadline.ms / 1000} s; it may be busy${
      operationId ? ` (operation ${operationId})` : ""
    }.`,
    "Run rig activity to see what rigd is doing, then retry; reads are answered without queueing.",
    { timeoutMs: deadline.ms, ...(operationId ? { operationId } : {}) },
  );
/** A request without a deadline that timed out all the same: rigd took it, so it was reached, and it finishes the command
 * whether or not anyone waits. */
const unanswered = (command: RuntimeCommand | undefined) =>
  new RigError(
    "DAEMON_TIMEOUT",
    `rigd took the ${command?.action ?? "request"} but the connection timed out before it answered${
      command?.operationId ? ` (operation ${command.operationId})` : ""
    }; it may still be running.`,
    "Run rig activity to see whether it finished.",
    command?.operationId ? { operationId: command.operationId } : {},
  );
/** How long one read may go unanswered, and what to call it when it does. */
interface ReadDeadline {
  ms: number;
  subject: string;
}
const protocolFailure = () =>
  new RigError(
    "DAEMON_PROTOCOL",
    "rigd returned an invalid response.",
    "Check that rig and rigd use the same version.",
  );

/** How long a read waits for rigd when the client is not told otherwise. */
export const DEFAULT_READ_DEADLINE_MS = 5000;
/** How the client waits on rigd; every field has the platform default when absent. */
export interface DaemonClientOptions {
  /** Milliseconds a status, list, or doctor read may go unanswered before it fails as DAEMON_TIMEOUT;
   * `DEFAULT_READ_DEADLINE_MS` when absent. */
  readonly readDeadlineMs?: number;
}
const abandoned = () =>
  cancelled(
    "rigd keeps running whatever it was asked; run rig activity to see it.",
  );
/** Every read rig prints must match its report schema, and a logs reply must name the Project asked for; a reply that
 * does not is DAEMON_PROTOCOL, never a report. Mutations' replies pass through as received. */
function validated(command: RuntimeCommand, result: unknown): unknown {
  if (!Object.hasOwn(readResultSchemas, command.action)) return result;
  const report =
    readResultSchemas[
      command.action as keyof typeof readResultSchemas
    ].safeParse(result);
  if (!report.success) throw protocolFailure();
  if (
    command.action === "logs" &&
    command.project !== undefined &&
    (report.data as { project: string }).project !== command.project
  )
    throw protocolFailure();
  return report.data;
}
/** Network adapter. Reads carry a deadline; mutations wait for rigd, which owns
 * every command budget, however long it takes. A timeout is DAEMON_TIMEOUT (the
 * operation may still be running), a failed connection is DAEMON_UNREACHABLE.
 * Replies are untrusted input. */
export class DaemonClient {
  private readonly readDeadlineMs: number;
  constructor(
    private readonly address: DaemonAddress,
    options: DaemonClientOptions = {},
  ) {
    this.readDeadlineMs = options.readDeadlineMs ?? DEFAULT_READ_DEADLINE_MS;
  }
  async health(): Promise<DaemonHealth> {
    const health = healthSchema.safeParse(
      await this.request("/health", undefined, {
        ms: 1500,
        subject: "health probe",
      }),
    );
    if (!health.success) throw protocolFailure();
    return health.data;
  }
  /** The signal abandons the read as CANCELLED, as for `command`. */
  async status(
    selection: StatusSelection,
    signal?: AbortSignal,
  ): Promise<ProjectStatusReport> {
    const envelope = resultSchema.safeParse(
      await this.request(
        "/v1/command",
        { ...selection, action: "status" },
        { ms: this.readDeadlineMs, subject: "status read" },
        signal,
      ),
    );
    if (!envelope.success) throw protocolFailure();
    const report = projectStatusSchema.safeParse(envelope.data.result);
    if (
      !report.success ||
      (selection.project !== undefined &&
        report.data.project !== selection.project)
    )
      throw protocolFailure();
    return report.data;
  }
  /** The signal abandons the request as CANCELLED; rigd is not told and finishes the command on its own. */
  async command(
    command: RuntimeCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (command.action === "status") return this.status(command, signal);
    const envelope = resultSchema.safeParse(
      await this.request(
        "/v1/command",
        command,
        ["status", "list", "doctor", "monitor"].includes(command.action)
          ? { ms: this.readDeadlineMs, subject: `${command.action} read` }
          : undefined,
        signal,
      ),
    );
    if (!envelope.success) throw protocolFailure();
    return validated(command, envelope.data.result);
  }
  private async request(
    path: string,
    body: RuntimeCommand | undefined,
    deadline: ReadDeadline | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const limits = [
      ...(deadline ? [AbortSignal.timeout(deadline.ms)] : []),
      ...(signal ? [signal] : []),
    ];
    const init: RequestInit & { timeout: false } = {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${this.address.token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(limits.length ? { signal: AbortSignal.any(limits) } : {}),
      redirect: "error",
      // Off: Bun's fetch otherwise drops a request whose socket stays quiet for its idle timeout (about 5 minutes), and rigd
      // sends nothing until a command finishes. The deadline above is the only one.
      timeout: false,
    };
    let response: Response;
    try {
      response = await fetch(
        `http://127.0.0.1:${this.address.port}${path}`,
        init,
      );
    } catch (error) {
      if (signal?.aborted) throw abandoned();
      if ((error as { name?: string }).name === "TimeoutError")
        throw deadline
          ? deadlineExpired(deadline, body?.operationId)
          : unanswered(body);
      throw new RigError(
        "DAEMON_UNREACHABLE",
        "rigd is not reachable.",
        "Run 'rigd status' to inspect the daemon.",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw protocolFailure();
    }
    if (!response.ok) {
      const parsed = errorSchema.safeParse(payload);
      if (!parsed.success) throw protocolFailure();
      if (parsed.data.error.code === "INVALID_REQUEST")
        throw versionSkew(parsed.data.error.details);
      throw new RigError(
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.hint ?? "Run 'rigd status'.",
      );
    }
    return payload;
  }
}
