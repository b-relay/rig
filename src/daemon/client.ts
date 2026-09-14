import {
  projectStatusSchema,
  type ProjectStatusReport,
  type StatusSelection,
} from "../domain/project-status";
import { z } from "zod";
import { RigError } from "../domain/errors";
import { RIG_VERSION } from "../domain/version";
import type { DaemonAddress, DaemonHealth, RuntimeCommand } from "./protocol";

const healthSchema = z.object({
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  running: z.literal(true),
  version: z.string().min(1).optional(),
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
    `rig ${RIG_VERSION} sent a command that rigd ${rigd ?? "of an older version"} does not accept.`,
    "Run 'rigd install' to upgrade rigd to the same version as rig.",
    { rig: RIG_VERSION, ...(rigd ? { rigd } : {}) },
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

const readDeadlineMs = 5000;
/** Network adapter. Reads carry a deadline; mutations wait for rigd, which owns
 * every command budget. A deadline expiry is DAEMON_TIMEOUT (the operation may
 * still be running), a failed connection is DAEMON_UNREACHABLE. Replies are
 * untrusted input. */
export class DaemonClient {
  constructor(private readonly address: DaemonAddress) {}
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
  async status(selection: StatusSelection): Promise<ProjectStatusReport> {
    const envelope = resultSchema.safeParse(
      await this.request(
        "/v1/command",
        { ...selection, action: "status" },
        { ms: readDeadlineMs, subject: "status read" },
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
  async command(command: RuntimeCommand): Promise<unknown> {
    if (command.action === "status") return this.status(command);
    const envelope = resultSchema.safeParse(
      await this.request(
        "/v1/command",
        command,
        ["status", "list", "doctor"].includes(command.action)
          ? { ms: readDeadlineMs, subject: `${command.action} read` }
          : undefined,
      ),
    );
    if (!envelope.success) throw protocolFailure();
    return envelope.data.result;
  }
  private async request(
    path: string,
    body: RuntimeCommand | undefined,
    deadline: ReadDeadline | undefined,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.address.port}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${this.address.token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(deadline ? { signal: AbortSignal.timeout(deadline.ms) } : {}),
        redirect: "error",
      });
    } catch (error) {
      if (deadline && (error as { name?: string }).name === "TimeoutError")
        throw deadlineExpired(deadline, body?.operationId);
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
