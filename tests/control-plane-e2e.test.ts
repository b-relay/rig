import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

/** Starts a command upload that never finishes, and answers all rigd sent once rigd closes the connection. Fails when the
 * connection cannot be made, or when rigd has not closed it within `ms`. */
function stalledUpload(
  port: number,
  token: string,
  ms: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const deadline = setTimeout(
      () =>
        reject(
          new Error(
            `rigd had not closed the stalled upload within ${ms / 1000} s; it had sent ${JSON.stringify(received)}`,
          ),
        ),
      ms,
    );
    const fail = (error: Error) => {
      clearTimeout(deadline);
      reject(error);
    };
    const unconnected = (error: Error) =>
      fail(
        new Error(
          `The stalled upload could not connect to rigd: ${error.message}`,
        ),
      );
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(
            `POST /v1/command HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`,
          );
        },
        data(_socket, chunk) {
          received += chunk.toString();
        },
        close() {
          clearTimeout(deadline);
          resolve(received);
        },
        error(_socket, error) {
          fail(error);
        },
        connectError(_socket, error) {
          unconnected(error);
        },
      },
    }).catch(unconnected);
  });
}

test("a real rigd closes a stalled upload at its documented bound, refuses bad requests with its one error document, and keeps their evidence without the token", async () => {
  const f = await rigFixture();
  try {
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    const { port } = JSON.parse(
      await readFile(join(f.root, "daemon", "address.json"), "utf8"),
    ) as { port: number };
    const token = (
      await readFile(join(f.root, "auth", "control-plane.token"), "utf8")
    ).trim();
    const url = `http://127.0.0.1:${port}`;
    // Started first and read last: it takes rigd's whole ten seconds. A failure is kept for where it is read, rather than
    // reported unhandled while the requests below run.
    const stalled = stalledUpload(port, token, 40_000);
    stalled.catch(() => {});
    const unauthorized = await fetch(`${url}/v1/command?secret=SENTINEL`, {
      method: "POST",
      headers: { authorization: "Bearer SENTINEL" },
      body: "SENTINEL",
    });
    expect(unauthorized.status).toBe(401);
    const unsupported = await fetch(`${url}/v1/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/plain",
      },
      body: JSON.stringify({ action: "list" }),
    });
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
    const refused = await stalled;
    expect(refused).toContain("HTTP/1.1 408");
    expect(refused).toContain('"code":"REQUEST_TIMEOUT"');
    expect(refused).toContain("within 10 s");
    // The evidence is written after the reply; each rigd status gives it the time. Every day's segment is read: across
    // midnight UTC, the 408's entry starts a new rigd.jsonl and the earlier ones move to the day's archive.
    const logs = join(f.root, "logs", "rigd");
    const segments = async () => {
      const names = (await readdir(logs))
        .filter((name) => /^rigd(-.+)?\.jsonl$/.test(name))
        .sort();
      const texts = names.map((name) => readFile(join(logs, name), "utf8"));
      return (await Promise.all(texts)).join("");
    };
    const codes = ["UNAUTHORIZED", "UNSUPPORTED_MEDIA_TYPE", "REQUEST_TIMEOUT"];
    let text = "";
    for (const deadline = Date.now() + 30_000; ; await f.rigd(["status"])) {
      text = await segments().catch(() => "");
      const missing = codes.filter((code) => !text.includes(code));
      if (missing.length === 0) break;
      if (Date.now() > deadline)
        throw new Error(
          `rigd's log segments still lacked ${missing.join(", ")} 30 s after the replies; they held:\n${text}`,
        );
    }
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain(token);
    const entries = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, string>)
      .filter((entry) => entry.event === "transport.refused");
    const duration = expect.stringMatching(/^\d+$/);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: "command",
          status: "401",
          code: "UNAUTHORIZED",
          durationMs: duration,
        }),
        expect.objectContaining({
          route: "command",
          status: "415",
          code: "UNSUPPORTED_MEDIA_TYPE",
          durationMs: duration,
        }),
        expect.objectContaining({
          route: "command",
          status: "408",
          code: "REQUEST_TIMEOUT",
          durationMs: duration,
        }),
      ]),
    );
  } finally {
    await f.cleanup();
  }
}, 120_000);
