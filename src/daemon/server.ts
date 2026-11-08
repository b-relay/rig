import { timingSafeEqual } from "node:crypto";
import { commandSchema, type RuntimeCommand } from "./protocol";
import { RigError, asRigError } from "../domain/errors";
import { RIG_BUILD } from "../domain/version";
import { receiveJson, type BodyRefusal } from "./request-body";
import type { TransportOutcome } from "./transport-evidence";

/** The most a control-plane request may carry. */
const MAX_REQUEST_BYTES = 1024 * 1024;
/** How long a caller has to upload a request; a complete command then runs for as long as its work takes. */
const BODY_DEADLINE_MS = 10_000;

export interface ControlPlaneOptions {
  port: number;
  token: string;
  instanceId: string;
  handle(command: RuntimeCommand): Promise<unknown>;
  editor?(input: unknown): Promise<unknown>;
  /** Operator env files (secrets): read names, reveal one value, or write. Its body is never logged. */
  env?(input: unknown): Promise<unknown>;
  /** Where rigd serves the dashboard, reported by /health; absent when it runs none, or (a function answering undefined)
   * once it has stopped it. */
  dashboard?: string | (() => string | undefined);
  /** Why the dashboard it runs is not served now (see Dashboard.problem), or is published elsewhere than Host config asks,
   * reported by /health. */
  dashboardProblem?: () => string | undefined | Promise<string | undefined>;
  /** How long a caller has to upload a request, in milliseconds; `BODY_DEADLINE_MS` when absent. */
  bodyDeadlineMs?: number;
  /** Told how each request ended that this boundary refused or failed; a command's own failure is the runtime's Operation
   * to record. Must not throw. */
  report?(outcome: TransportOutcome): void;
}
/** What a request is answered with. `code` marks a refusal or failure of this boundary. */
interface Reply {
  status: number;
  /** The JSON document; absent for an answer without a body. */
  body?: unknown;
  code?: string;
  /** A failure's class of error. */
  cause?: string;
}
/** The one shape of everything this boundary refuses. Never echoes what the request carried. */
function refusal(
  status: number,
  code: string,
  message: string,
  hint: string,
  extra: { details?: unknown; issues?: unknown } = {},
): Reply {
  return { status, code, body: { error: { code, message, hint, ...extra } } };
}
const failed = (cause: string): Reply => ({
  ...refusal(
    500,
    "HTTP_FAILURE",
    "The daemon could not process this request.",
    "Run rig doctor; rigd's diagnostic log (logs/rigd under the Rig root) records the failure as transport.failed.",
  ),
  cause,
});
/** A request that is not the JSON document it should be; `rig` only sends what its own grammar accepts, so `hint` names
 * the version too. The client reads `details.version` to name both versions in its message about a mismatch. */
const invalidRequest = (message: string, hint: string): Reply =>
  refusal(400, "INVALID_REQUEST", message, hint, {
    details: { version: RIG_BUILD },
  });
/** Pure: why a body was refused, as this boundary answers it; `invalid` is the route's own for a body that is not JSON. */
function refusedBody(
  refused: BodyRefusal,
  deadlineMs: number,
  invalid: Reply,
): Reply {
  if (refused === "media-type")
    return refusal(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "rigd accepts only application/json requests.",
      `Send the request with Content-Type: application/json, as rig and the dashboard do; check that they are the same version as rigd (rigd is ${RIG_BUILD}).`,
    );
  if (refused === "too-large")
    return refusal(
      413,
      "REQUEST_TOO_LARGE",
      `The request is larger than the ${MAX_REQUEST_BYTES / (1024 * 1024)} MiB rigd accepts.`,
      "Send less in one request. Nothing was changed.",
    );
  if (refused === "stalled")
    return refusal(
      408,
      "REQUEST_TIMEOUT",
      `The request did not finish uploading within ${deadlineMs / 1000} s.`,
      "Send the whole request without pausing, then retry. Nothing was changed.",
    );
  if (refused === "cut-off")
    return refusal(
      400,
      "REQUEST_INCOMPLETE",
      "The connection closed before the request finished uploading.",
      "Send the whole request, then retry. Nothing was changed.",
    );
  return invalid;
}
/** A body an editor route cannot read as JSON. */
const invalidEdit = (what: string): Reply =>
  invalidRequest(
    `Invalid ${what} request.`,
    `Send one JSON document the ${what} accepts, and check that the dashboard and rigd are the same version (rigd is ${RIG_BUILD}).`,
  );
/** One JSON request to an editor route: its result, or its refusal with the code, message and hint the
 * editor gave. */
async function edit(
  input: unknown,
  editor: (input: unknown) => Promise<unknown>,
  /** Pass a config validation failure's field problems on; only the config editor's are config. */
  withIssues = false,
): Promise<Reply> {
  try {
    return { status: 200, body: { result: await editor(input) } };
  } catch (error) {
    const failure = asRigError(error);
    const issues = withIssues ? configIssues(failure.details) : undefined;
    return refusal(
      422,
      failure.code,
      failure.message,
      failure.hint,
      issues ? { issues } : {},
    );
  }
}
/** Pure: the fixed category of a request's path, the only part of its URL evidence keeps. */
function routeOf(pathname: string): TransportOutcome["route"] {
  if (pathname === "/health") return "health";
  if (pathname === "/v1/command") return "command";
  if (pathname === "/v1/config") return "config";
  if (pathname === "/v1/env") return "env";
  return "other";
}
/** The class of a failure, never its message. */
function failureCause(error: unknown): string {
  if (error instanceof RigError) return error.code;
  return error instanceof Error ? error.name : typeof error;
}
/** A refusal may leave its body unread, and a connection that waits for the rest would stay open for as long as the caller
 * leaves it there; only an operation's failure (422) has read all it was sent. */
function rendered(reply: Reply): Response {
  const close =
    reply.status >= 400 && reply.status !== 422
      ? { headers: { connection: "close" } }
      : {};
  return reply.body === undefined
    ? new Response(null, { status: reply.status })
    : Response.json(reply.body, { status: reply.status, ...close });
}
/** Pure: the field problems a config validation failure names, each as a path and a message, so the
 * dashboard can show each beside its field. At most 50; anything not of that shape is left out. */
export function configIssues(
  details: Readonly<Record<string, unknown>>,
): { path: string[]; message: string }[] | undefined {
  if (!Array.isArray(details.issues)) return undefined;
  const issues = details.issues
    .filter(
      (issue): issue is { path: unknown[]; message: string } =>
        typeof issue === "object" &&
        issue !== null &&
        Array.isArray((issue as { path?: unknown }).path) &&
        typeof (issue as { message?: unknown }).message === "string",
    )
    .slice(0, 50)
    .map((issue) => ({
      path: issue.path.map(String),
      message: issue.message.slice(0, 500),
    }));
  return issues.length ? issues : undefined;
}

function authenticated(request: Request, token: string): boolean {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Only a page served by this daemon on its own loopback port could be a legitimate browser caller. */
function ownLoopbackOrigin(origin: string, port: number): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].some(
    (host) => origin.toLowerCase() === `http://${host}:${port}`,
  );
}
/** HTTP effect owner; lifecycle remains owned by the injected runtime handler. */
export function startControlPlane(options: ControlPlaneOptions) {
  if (options.token.length === 0)
    throw new RigError(
      "DAEMON_TOKEN",
      "A local daemon token is required.",
      "Run 'rigd install' to reissue the daemon credential.",
      { port: options.port },
    );
  const bodyDeadlineMs = options.bodyDeadlineMs ?? BODY_DEADLINE_MS;
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    // Off: Bun's own limit answers a bare 413 before any of this runs. receiveJson holds MAX_REQUEST_BYTES instead.
    maxRequestBodySize: Infinity,
    // Mutations legitimately run for minutes; the runtime owns their budgets.
    // Bun would otherwise reset a request that is still being handled after 10 s.
    // Receiving a request has its own deadline (BODY_DEADLINE_MS).
    idleTimeout: 0,
    async fetch(request, server) {
      const started = performance.now();
      const route = routeOf(new URL(request.url).pathname);
      let reply: Reply, response: Response;
      try {
        reply = await answer(request, server.port ?? options.port);
        response = rendered(reply);
      } catch (error) {
        reply = failed(failureCause(error));
        response = rendered(reply);
      }
      if (reply.code)
        options.report?.({
          route,
          status: reply.status,
          code: reply.code,
          durationMs: performance.now() - started,
          ...(reply.cause ? { cause: reply.cause } : {}),
        });
      return response;
    },
    error() {
      return rendered(failed("unknown"));
    },
  });
  async function answer(request: Request, port: number): Promise<Reply> {
    if (!authenticated(request, options.token))
      return refusal(
        401,
        "UNAUTHORIZED",
        "Invalid local daemon credentials.",
        "Send the token in auth/control-plane.token under this Host's Rig root.",
      );
    const url = new URL(request.url);
    // The Bearer token is the protection; a browser page can only be this daemon's own
    // loopback origin, so the comparison never trusts the Host header a rebinding attacker sets.
    const origin = request.headers.get("origin");
    if (origin && !ownLoopbackOrigin(origin, port))
      return refusal(
        403,
        "ORIGIN",
        "This browser origin is not allowed.",
        "Reach rigd through rig or the dashboard; a page may call it directly only from rigd's own loopback address.",
      );
    if (url.pathname === "/health" && request.method === "GET")
      return {
        status: 200,
        body: {
          instanceId: options.instanceId,
          pid: process.pid,
          running: true,
          version: RIG_BUILD,
          ...((dashboard) => (dashboard ? { dashboard } : {}))(
            typeof options.dashboard === "function"
              ? options.dashboard()
              : options.dashboard,
          ),
          ...((problem) => (problem ? { dashboardProblem: problem } : {}))(
            await options.dashboardProblem?.(),
          ),
        },
      };
    // Probes that only want the status line (HEAD) get it without a body.
    if (url.pathname === "/health" && request.method === "HEAD")
      return { status: 200 };
    if (
      url.pathname === "/v1/config" &&
      request.method === "POST" &&
      options.editor
    ) {
      const editor = options.editor;
      return await withBody(request, invalidEdit("config editor"), (input) =>
        edit(input, editor, true),
      );
    }
    if (
      url.pathname === "/v1/env" &&
      request.method === "POST" &&
      options.env
    ) {
      const editor = options.env;
      return await withBody(request, invalidEdit("env editor"), (input) =>
        edit(input, editor),
      );
    }
    if (url.pathname !== "/v1/command" || request.method !== "POST")
      return refusal(
        404,
        "NOT_FOUND",
        "rigd has no such route.",
        `Check that the caller and rigd are the same version (rigd is ${RIG_BUILD}).`,
      );
    const invalid = invalidRequest(
      "Invalid Rig command.",
      `Check the command arguments, and that rig and rigd are the same version (rigd is ${RIG_BUILD}).`,
    );
    return await withBody(request, invalid, async (input) => {
      const parsed = commandSchema.safeParse(input);
      return parsed.success ? await run(parsed.data) : invalid;
    });
  }
  /** Receives the request's JSON and answers with `then`, or refuses it; `invalid` is the route's refusal of a body that
   * is not JSON. Every route with a body comes through here, so all of them hold one contract. */
  async function withBody(
    request: Request,
    invalid: Reply,
    then: (input: unknown) => Promise<Reply>,
  ): Promise<Reply> {
    const input = await receiveJson(request, {
      maxBytes: MAX_REQUEST_BYTES,
      deadlineMs: bodyDeadlineMs,
    });
    return "refused" in input
      ? refusedBody(input.refused, bodyDeadlineMs, invalid)
      : await then(input.value);
  }
  /** A command's result, or its failure, which the runtime has recorded as an Operation. */
  async function run(command: RuntimeCommand): Promise<Reply> {
    try {
      return { status: 200, body: { result: await options.handle(command) } };
    } catch (error) {
      const failure = asRigError(error);
      return {
        status: 422,
        body: {
          error: {
            code: failure.code,
            message: failure.message,
            hint: failure.hint,
          },
          operationId: command.operationId,
        },
      };
    }
  }
}
