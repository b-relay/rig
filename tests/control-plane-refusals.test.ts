import { expect, spyOn, test } from "bun:test";
import { startControlPlane } from "../src/daemon/server";
import { RigError } from "../src/domain/errors";
import { RIG_BUILD } from "../src/domain/version";

const token = "test-secret";
const routes = ["/v1/command", "/v1/config", "/v1/env"] as const;

/** A control plane whose runtime and editors only count what reaches them. */
function controlPlane(
  options: Partial<Parameters<typeof startControlPlane>[0]> = {},
) {
  const reached: unknown[] = [];
  const server = startControlPlane({
    port: 0,
    token,
    instanceId: "instance-1",
    handle: async (command) => {
      reached.push(command);
      return { ok: true };
    },
    editor: async (input) => {
      reached.push(input);
      return { ok: true };
    },
    env: async (input) => {
      reached.push(input);
      return { ok: true };
    },
    ...options,
  });
  return { server, reached };
}
const headers = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  ...extra,
});
const post = (
  port: number,
  path: string,
  body: BodyInit,
  extra: Record<string, string> = {},
) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: headers(extra),
    body,
  });
/** The head of a POST that declares `length` bytes of body. */
const head = (path: string, length: number, credentials = token) =>
  `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${credentials}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`;
/** Writes `text` on a raw socket and answers all rigd sent once rigd closes it, optionally writing one more byte every
 * `dripMs` until then. Hangs, failing its test, when rigd never closes it. */
function untilClosed(
  port: number,
  text: string,
  dripMs?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    let drip: ReturnType<typeof setInterval> | undefined;
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(text);
          if (dripMs !== undefined)
            drip = setInterval(() => socket.write(" "), dripMs);
        },
        data(_socket, chunk) {
          received += chunk.toString();
        },
        close() {
          clearInterval(drip);
          resolve(received);
        },
        error(_socket, error) {
          clearInterval(drip);
          reject(error);
        },
      },
    });
  });
}
/** The status and JSON document of one raw HTTP reply. */
function parsedReply(reply: string): {
  status: number;
  body: { error: { code: string; message: string; hint: string } };
} {
  const [top, ...rest] = reply.split("\r\n\r\n");
  return {
    status: Number(top!.split(" ")[1]),
    body: JSON.parse(rest.join("\r\n\r\n")),
  };
}

test("a stalled or dripping upload is refused at the receive deadline and its connection closed, on every route", async () => {
  const { server, reached } = controlPlane({ bodyDeadlineMs: 50 });
  try {
    for (const path of routes) {
      const stalled = parsedReply(
        await untilClosed(server.port!, `${head(path, 100)}{`),
      );
      expect(stalled.status).toBe(408);
      expect(stalled.body.error).toMatchObject({
        code: "REQUEST_TIMEOUT",
        hint: expect.stringContaining("Send the whole request"),
      });
    }
    // Each byte is on time, but the deadline covers the whole upload.
    const dripping = parsedReply(
      await untilClosed(server.port!, `${head("/v1/command", 100_000)}{`, 5),
    );
    expect(dripping.body.error.code).toBe("REQUEST_TIMEOUT");
    expect(reached).toEqual([]);
    // rigd still serves.
    const answer = await post(
      server.port!,
      "/v1/command",
      JSON.stringify({ action: "list" }),
    );
    expect(await answer.json()).toEqual({ result: { ok: true } });
  } finally {
    await server.stop(true);
  }
});

test("an upload's timer runs for the documented 10 s, or the deadline the control plane is given", async () => {
  const real = globalThis.setTimeout;
  const delays: (number | undefined)[] = [];
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
    ...args: Parameters<typeof setTimeout>
  ) => {
    delays.push(args[1]);
    return real(...args);
  }) as typeof setTimeout);
  const documented = controlPlane();
  const given = controlPlane({ bodyDeadlineMs: 50 });
  try {
    const command = JSON.stringify({ action: "list" });
    await post(documented.server.port!, "/v1/command", command);
    expect(delays).toEqual([10_000]);
    delays.length = 0;
    await post(given.server.port!, "/v1/command", command);
    expect(delays).toEqual([50]);
  } finally {
    timers.mockRestore();
    await documented.server.stop(true);
    await given.server.stop(true);
  }
});

test("a request refused before its body is read closes its connection, so an unfinished upload holds nothing", async () => {
  const { server } = controlPlane();
  try {
    expect(
      parsedReply(
        await untilClosed(
          server.port!,
          `${head("/v1/command", 100, "not-the-token")}{`,
        ),
      ).body.error.code,
    ).toBe("UNAUTHORIZED");
    expect(
      parsedReply(await untilClosed(server.port!, `${head("/nowhere", 100)}{`))
        .body.error.code,
    ).toBe("NOT_FOUND");
  } finally {
    await server.stop(true);
  }
});

test("the receive deadline ends at the body: a complete command runs on for as long as it takes", async () => {
  const running = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const { server } = controlPlane({
    bodyDeadlineMs: 50,
    handle: async () => {
      running.resolve();
      await finish.promise;
      return { finished: true };
    },
  });
  try {
    const long = post(
      server.port!,
      "/v1/command",
      JSON.stringify({ action: "up" }),
    );
    await running.promise;
    // A stalled upload has been refused, so the receive deadline has passed since the command started running.
    await untilClosed(server.port!, `${head("/v1/command", 100)}{`);
    finish.resolve();
    const answer = await long;
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ result: { finished: true } });
  } finally {
    finish.resolve();
    await server.stop(true);
  }
});

test("malformed JSON gets one refusal with a hint on every route, and never echoes what was sent", async () => {
  const { server, reached } = controlPlane();
  try {
    for (const path of routes) {
      const refused = await post(server.port!, path, '{"secret":"SENTINEL"');
      expect(refused.status).toBe(400);
      const text = await refused.text();
      expect(text).not.toContain("SENTINEL");
      expect(JSON.parse(text)).toEqual({
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringMatching(/^Invalid /),
          hint: expect.stringContaining(`rigd is ${RIG_BUILD}`),
          details: { version: RIG_BUILD },
        },
      });
    }
    expect(reached).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("a media type other than JSON is refused on every route; JSON with a parameter or in another case is accepted", async () => {
  const { server, reached } = controlPlane();
  const command = JSON.stringify({ action: "list" });
  try {
    for (const path of routes) {
      const refused = await post(server.port!, path, command, {
        "content-type": "text/plain",
      });
      expect(refused.status).toBe(415);
      expect(await refused.json()).toEqual({
        error: {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: expect.stringContaining("application/json"),
          hint: expect.any(String),
        },
      });
    }
    const untyped = await fetch(`http://127.0.0.1:${server.port}/v1/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: new TextEncoder().encode(command),
    });
    expect(untyped.status).toBe(415);
    expect(reached).toEqual([]);
    for (const type of [
      "application/json; charset=utf-8",
      "Application/JSON",
    ]) {
      const accepted = await post(server.port!, "/v1/command", command, {
        "content-type": type,
      });
      expect(accepted.status).toBe(200);
    }
    expect(reached).toHaveLength(2);
  } finally {
    await server.stop(true);
  }
});

test("an oversized upload gets a tagged refusal however it declares itself, and 1 MiB still fits", async () => {
  const { server, reached } = controlPlane();
  const max = 1024 * 1024;
  try {
    for (const path of routes)
      // Declared: refused from its headers, without a byte of the body. 2^53 is past any limit Bun could be given but Infinity.
      for (const length of [max + 1, 2 ** 53]) {
        const declared = parsedReply(
          await untilClosed(server.port!, head(path, length)),
        );
        expect(declared.status).toBe(413);
        expect(declared.body.error).toMatchObject({
          code: "REQUEST_TOO_LARGE",
          message: expect.stringContaining("1 MiB"),
          hint: expect.any(String),
        });
      }
    const whole = await post(
      server.port!,
      "/v1/command",
      "x".repeat(1100 * 1024),
    );
    expect(whole.status).toBe(413);
    expect(((await whole.json()) as any).error.code).toBe("REQUEST_TOO_LARGE");
    // Undeclared: counted as it arrives, and refused once it passes the limit.
    const endless = await post(
      server.port!,
      "/v1/command",
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(256 * 1024));
        },
      }),
    );
    expect(endless.status).toBe(413);
    expect(((await endless.json()) as any).error.code).toBe(
      "REQUEST_TOO_LARGE",
    );
    expect(reached).toEqual([]);
    const command = JSON.stringify({ action: "list" });
    const fits = await post(
      server.port!,
      "/v1/command",
      command + " ".repeat(max - command.length),
    );
    expect(fits.status).toBe(200);
    expect(reached).toHaveLength(1);
  } finally {
    await server.stop(true);
  }
});

test("every refusal and failure of the control plane is one tagged document with a hint", async () => {
  const { server } = controlPlane({
    dashboardProblem: async () => {
      throw new Error("SENTINEL");
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const cases: [Promise<Response>, number, string][] = [
      [fetch(`${url}/v1/command`, { method: "POST" }), 401, "UNAUTHORIZED"],
      [
        fetch(`${url}/health`, {
          headers: { ...headers(), origin: "https://evil.example" },
        }),
        403,
        "ORIGIN",
      ],
      [fetch(`${url}/nowhere`, { headers: headers() }), 404, "NOT_FOUND"],
      [fetch(`${url}/health`, { headers: headers() }), 500, "HTTP_FAILURE"],
    ];
    for (const [answer, status, code] of cases) {
      const response = await answer;
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).not.toContain("SENTINEL");
      expect(JSON.parse(text)).toEqual({
        error: {
          code,
          message: expect.any(String),
          hint: expect.any(String),
        },
      });
    }
  } finally {
    await server.stop(true);
  }
});

test("each refusal and failure is reported with its route, status, code and duration, never what the request carried", async () => {
  const reported: unknown[] = [];
  const { server } = controlPlane({
    report: (outcome: unknown) => reported.push(outcome),
    dashboardProblem: async () => {
      throw new TypeError("SENTINEL");
    },
    env: async () => {
      throw new RigError("ENV_REVISION", "SENTINEL moved.", "Reload.");
    },
    handle: async () => {
      throw new RigError("TARGET_MISSING", "SENTINEL gone.", "Deploy it.");
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    await fetch(`${url}/v1/command?token=SENTINEL`, { method: "POST" });
    await post(server.port!, "/v1/config", "{");
    await post(server.port!, "/v1/env", JSON.stringify({ action: "read" }));
    await fetch(`${url}/health`, { headers: headers() });
    await fetch(`${url}/SENTINEL`, { headers: headers() });
    // Reported by the runtime as an Operation already, under its Operation id.
    await post(
      server.port!,
      "/v1/command",
      JSON.stringify({ action: "up", operationId: "op-1" }),
    );
    // A success is nothing to report.
    await fetch(`${url}/health`, { method: "HEAD", headers: headers() });
    const durations = expect.any(Number);
    expect(reported).toEqual([
      {
        route: "command",
        status: 401,
        code: "UNAUTHORIZED",
        durationMs: durations,
      },
      {
        route: "config",
        status: 400,
        code: "INVALID_REQUEST",
        durationMs: durations,
      },
      {
        route: "env",
        status: 422,
        code: "ENV_REVISION",
        durationMs: durations,
      },
      {
        route: "health",
        status: 500,
        code: "HTTP_FAILURE",
        cause: "TypeError",
        durationMs: durations,
      },
      {
        route: "other",
        status: 404,
        code: "NOT_FOUND",
        durationMs: durations,
      },
    ]);
    expect(JSON.stringify(reported)).not.toContain("SENTINEL");
  } finally {
    await server.stop(true);
  }
});
