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
    ) {
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        return Response.json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "Invalid config editor request.",
            },
          },
          { status: 400 },
        );
      }
      try {
        return Response.json({ result: await options.editor(input) });
      } catch (error) {
        const failure = asRigError(error);
        return Response.json(
          {
            error: {
              code: failure.code,
              message: failure.message,
              hint: failure.hint,
            },
          },
          { status: 422 },
        );
      }
    }
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
