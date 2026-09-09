import {
  projectStatusSchema,
  type ProjectStatusReport,
  type StatusSelection,
} from "../domain/project-status";
import { z } from "zod";
import { RigError } from "../domain/errors";
import type { DaemonAddress, DaemonHealth, RuntimeCommand } from "./protocol";

const healthSchema = z.object({
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  running: z.literal(true),
});
const errorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    hint: z.string().optional(),
  }),
});
const resultSchema = z
  .object({ result: z.unknown() })
  .refine((value) => Object.hasOwn(value, "result"));
const protocolFailure = () =>
  new RigError(
    "DAEMON_PROTOCOL",
    "rigd returned an invalid response.",
    "Check that rig and rigd use the same version.",
  );

/** Network adapter. Deadlines abort requests; callers own retry policy. Replies are untrusted input. */
export class DaemonClient {
  constructor(private readonly address: DaemonAddress) {}
  async health(): Promise<DaemonHealth> {
    const health = healthSchema.safeParse(
      await this.request("/health", undefined, 1500),
    );
    if (!health.success) throw protocolFailure();
    return health.data;
  }
  async status(selection: StatusSelection): Promise<ProjectStatusReport> {
    const envelope = resultSchema.safeParse(
      await this.request(
        "/v1/command",
        { ...selection, action: "status" },
        5000,
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
        ["status", "list", "doctor"].includes(command.action) ? 5000 : 300000,
      ),
    );
    if (!envelope.success) throw protocolFailure();
    return envelope.data.result;
  }
  private async request(
    path: string,
    body: RuntimeCommand | undefined,
    timeoutMs: number,
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
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
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
      throw new RigError(
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.hint ?? "Run 'rigd status'.",
      );
    }
    return payload;
  }
}
