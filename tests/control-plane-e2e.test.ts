import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

/** Starts a command upload that never finishes, and answers all rigd sent once rigd closes the connection. */
function stalledUpload(port: number, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    void Bun.connect({
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
          resolve(received);
        },
        error(_socket, error) {
          reject(error);
        },
      },
    });
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
    // Started first and read last: it takes rigd's whole ten seconds.
    const stalled = stalledUpload(port, token);
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
    // The evidence is written after the reply; each rigd status gives it the time.
    const log = join(f.root, "logs", "rigd", "rigd.jsonl");
    let text = "";
    for (;;) {
      text = await readFile(log, "utf8").catch(() => "");
      if (
        ["UNAUTHORIZED", "UNSUPPORTED_MEDIA_TYPE", "REQUEST_TIMEOUT"].every(
          (code) => text.includes(code),
        )
      )
        break;
      await f.rigd(["status"]);
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
