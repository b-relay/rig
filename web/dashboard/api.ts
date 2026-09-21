import type {
  ActivityResult,
  ConfigChange,
  ConfigEditorRequest,
  ConfigRead,
  ConfigReport,
  DaemonHealth,
  DeploymentContext,
  DoctorReport,
  InitializationInfo,
  ListResult,
  LogsResult,
  OperationResult,
  ProjectStatusReport,
  QueueResult,
  RecipeReport,
  RuntimeCommand,
} from "./types";

/** A refusal rigd answered with, or the transport failing before it could. */
export class RigdError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly operationId?: string,
  ) {
    super(message);
  }
}
/** The reply each action answers with; an action absent here answers an Operation result. */
interface Replies {
  list: ListResult;
  status: ProjectStatusReport;
  logs: LogsResult;
  activity: ActivityResult;
  doctor: DoctorReport;
  config: ConfigReport;
  "recipe-diff": RecipeReport;
  queue: QueueResult;
  "initialization-info": InitializationInfo;
  "deployment-context": DeploymentContext;
  "prepare-uninstall": { ready: true };
  "cancel-uninstall": { cancelled: true };
}
export type Reply<A extends RuntimeCommand["action"]> = A extends keyof Replies
  ? Replies[A]
  : OperationResult;
export interface RigdApi {
  health(): Promise<DaemonHealth>;
  command<A extends RuntimeCommand["action"]>(
    command: RuntimeCommand & { action: A },
    signal?: AbortSignal,
  ): Promise<Reply<A>>;
  config(
    request: ConfigEditorRequest & { action: "read" },
    signal?: AbortSignal,
  ): Promise<ConfigRead>;
  config(
    request: ConfigEditorRequest & { action: "preview" | "apply" },
    signal?: AbortSignal,
  ): Promise<ConfigChange>;
}
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function refusal(payload: unknown, status: number): RigdError {
  const body = payload as {
    error?: { code?: unknown; message?: unknown; hint?: unknown };
    operationId?: unknown;
  } | null;
  const error = body?.error;
  if (typeof error?.code !== "string" || typeof error.message !== "string")
    return new RigdError(
      "DAEMON_PROTOCOL",
      `rigd answered ${status} without an error report.`,
      "Reload the dashboard.",
    );
  return new RigdError(
    error.code,
    error.message,
    typeof error.hint === "string" ? error.hint : undefined,
    typeof body?.operationId === "string" ? body.operationId : undefined,
  );
}
/** Calls the site's own relay, which holds the control-plane credential; `send` is the only network effect. */
export function createRigdApi(send: Fetch): RigdApi {
  const request = async (
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await send(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new RigdError(
        "DAEMON_UNREACHABLE",
        "rigd is not reachable.",
        "Check that the Rig website Service is running: rig status --project rig.",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw refusal(null, response.status);
    }
    if (!response.ok) throw refusal(payload, response.status);
    return payload;
  };
  const result = async (path: string, body: unknown, signal?: AbortSignal) => {
    const payload = await request(path, body, signal);
    if (!payload || typeof payload !== "object" || !("result" in payload))
      throw refusal(null, 200);
    return payload.result;
  };
  return {
    health: async () => (await request("/api/health")) as DaemonHealth,
    command: async (command, signal) =>
      (await result(
        "/api/command",
        { operationId: crypto.randomUUID(), ...command },
        signal,
      )) as never,
    config: async (input: ConfigEditorRequest, signal?: AbortSignal) =>
      (await result("/api/config", input, signal)) as never,
  };
}
