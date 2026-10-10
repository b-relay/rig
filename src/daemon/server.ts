import { timingSafeEqual } from "node:crypto";
import { commandSchema, type RuntimeCommand } from "./protocol";
import { asRigError } from "../domain/errors";
import { RIG_BUILD } from "../domain/version";

export interface ControlPlaneOptions {
  port: number;
  token: string;
  instanceId: string;
  handle(command: RuntimeCommand): Promise<unknown>;
  editor?(input: unknown): Promise<unknown>;
  /** Operator env files (secrets): read names, reveal one value, or write. Its body is never logged. */
  env?(input: unknown): Promise<unknown>;
}
/** One JSON request to an editor route: its result, or its refusal with the code, message and hint the
 * editor gave. A body that is not JSON is refused without echoing it. */
async function edit(
  request: Request,
  editor: (input: unknown) => Promise<unknown>,
  what: string,
  /** Pass a config validation failure's field problems on; only the config editor's are config. */
  withIssues = false,
): Promise<Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: `Invalid ${what} request.`,
        },
      },
      { status: 400 },
    );
  }
  try {
    return Response.json({ result: await editor(input) });
  } catch (error) {
    const failure = asRigError(error);
    const issues = withIssues ? configIssues(failure.details) : undefined;
    return Response.json(
      {
        error: {
          code: failure.code,
          message: failure.message,
          hint: failure.hint,
          ...(issues ? { issues } : {}),
        },
      },
      { status: 422 },
    );
  }
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
    throw new Error("A local daemon token is required.");
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    maxRequestBodySize: 1024 * 1024,
    // Mutations legitimately run for minutes; the runtime owns their budgets.
    // Bun would otherwise reset a request that is still being handled after 10 s.
    idleTimeout: 0,
    fetch(request, server) {
      return answer(request, server.port ?? options.port);
    },
    error() {
      return Response.json(
        {
          error: {
            code: "HTTP_FAILURE",
            message: "The daemon could not process this request.",
          },
        },
        { status: 500 },
      );
    },
  });
  async function answer(request: Request, port: number): Promise<Response> {
    if (!authenticated(request, options.token))
      return Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid local daemon credentials.",
          },
        },
        { status: 401 },
      );
    const url = new URL(request.url);
    // The Bearer token is the protection; a browser page can only be this daemon's own
    // loopback origin, so the comparison never trusts the Host header a rebinding attacker sets.
    const origin = request.headers.get("origin");
    if (origin && !ownLoopbackOrigin(origin, port))
      return Response.json(
        {
          error: {
            code: "ORIGIN",
            message: "This browser origin is not allowed.",
          },
        },
        { status: 403 },
      );
    if (url.pathname === "/health" && request.method === "GET")
      return Response.json({
        instanceId: options.instanceId,
        pid: process.pid,
        running: true,
        version: RIG_BUILD,
      });
    // Probes that only want the status line (HEAD) get it without a body.
    if (url.pathname === "/health" && request.method === "HEAD")
      return new Response(null, { status: 200 });
    if (
      url.pathname === "/v1/config" &&
      request.method === "POST" &&
      options.editor
    )
      return await edit(request, options.editor, "config editor", true);
    if (url.pathname === "/v1/env" && request.method === "POST" && options.env)
      return await edit(request, options.env, "env editor");
    if (url.pathname !== "/v1/command" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    let command: RuntimeCommand;
    try {
      command = commandSchema.parse(await request.json());
    } catch {
      return Response.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid Rig command.",
            hint: `Check the command arguments, and that rig and rigd are the same version (rigd is ${RIG_BUILD}).`,
            details: { version: RIG_BUILD },
          },
        },
        { status: 400 },
      );
    }
    try {
      return Response.json({ result: await options.handle(command) });
    } catch (error) {
      const failure = asRigError(error);
      return Response.json(
        {
          error: {
            code: failure.code,
            message: failure.message,
            hint: failure.hint,
          },
          operationId: command.operationId,
        },
        { status: 422 },
      );
    }
  }
}
