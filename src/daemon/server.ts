import { timingSafeEqual } from "node:crypto";
import { commandSchema, type RuntimeCommand } from "./protocol";
import { asRigError } from "../domain/errors";

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

/** HTTP effect owner; lifecycle remains owned by the injected runtime handler. */
export function startControlPlane(options: ControlPlaneOptions) {
  if (options.token.length === 0)
    throw new Error("A local daemon token is required.");
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    maxRequestBodySize: 1024 * 1024,
    async fetch(request) {
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
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin)
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
        });
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
              hint: "Check the command arguments.",
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
}
