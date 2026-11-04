import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileDiagnosticLog } from "../src/diagnostics/file-log";
import type { DiagnosticEntry } from "../src/diagnostics/types";
import { startControlPlane } from "../src/daemon/server";
import { RigError } from "../src/domain/errors";
import {
  transportEvidence,
  type TransportOutcome,
} from "../src/daemon/transport-evidence";

const refused: TransportOutcome = {
  route: "command",
  status: 401,
  code: "UNAUTHORIZED",
  durationMs: 2.4,
};

test("a repeated refusal is one entry a window, the next saying how many it stands for, so a flood cannot grow the log", async () => {
  const entries: DiagnosticEntry[] = [];
  const summarized = Promise.withResolvers<void>();
  const report = transportEvidence((entry) => {
    entries.push(entry);
    if (entry.repeated) summarized.resolve();
  }, 20);
  for (let attempt = 0; attempt < 10_000; attempt++) report(refused);
  report({ ...refused, route: "env" });
  report({
    route: "health",
    status: 500,
    code: "HTTP_FAILURE",
    cause: "TypeError",
    durationMs: 1,
  });
  expect(entries).toEqual([
    {
      event: "transport.refused",
      level: "warn",
      route: "command",
      status: "401",
      code: "UNAUTHORIZED",
      durationMs: "2",
    },
    {
      event: "transport.refused",
      level: "warn",
      route: "env",
      status: "401",
      code: "UNAUTHORIZED",
      durationMs: "2",
    },
    {
      event: "transport.failed",
      level: "error",
      route: "health",
      status: "500",
      code: "HTTP_FAILURE",
      cause: "TypeError",
      durationMs: "1",
    },
  ]);
  await summarized.promise;
  expect(entries.slice(3)).toEqual([
    {
      event: "transport.refused",
      level: "warn",
      route: "command",
      status: "401",
      code: "UNAUTHORIZED",
      durationMs: "2",
      repeated: "9999",
    },
  ]);
});

test("the diagnostic log holds a refusal's route, status, code and duration, and no credential, URL, body or env value", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-transport-evidence-"));
  const log = createFileDiagnosticLog({
    root,
    source: "rigd",
    now: () => new Date("2026-11-03T12:00:00Z"),
  });
  const writes: Promise<unknown>[] = [];
  const server = startControlPlane({
    port: 0,
    token: "SENTINEL-TOKEN",
    instanceId: "instance-1",
    handle: async () => ({}),
    env: async () => {
      throw new RigError(
        "ENV_REVISION",
        "SENTINEL-VALUE moved.",
        "SENTINEL-VALUE",
      );
    },
    dashboardProblem: async () => {
      throw new Error("SENTINEL-VALUE");
    },
    report: transportEvidence((entry) => writes.push(log.record(entry))),
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const authorization = { authorization: "Bearer SENTINEL-TOKEN" };
    const json = { ...authorization, "content-type": "application/json" };
    await fetch(`${url}/v1/command?secret=SENTINEL-URL`, {
      method: "POST",
      headers: { authorization: "Bearer SENTINEL-WRONG" },
      body: "SENTINEL-BODY",
    });
    await fetch(`${url}/SENTINEL-URL?token=SENTINEL-URL`, {
      headers: authorization,
    });
    await fetch(`${url}/v1/command`, {
      method: "POST",
      headers: { ...json, referer: "SENTINEL-HEADER" },
      body: '{"env":"SENTINEL-VALUE"',
    });
    await fetch(`${url}/v1/env`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ action: "write", value: "SENTINEL-VALUE" }),
    });
    await fetch(`${url}/health`, { headers: authorization });
    await Promise.all(writes);
    const text = await readFile(join(root, "logs/rigd/rigd.jsonl"), "utf8");
    expect(text).not.toContain("SENTINEL");
    expect(
      text
        .trim()
        .split("\n")
        .map((line) => {
          const { timestamp, durationMs, ...entry } = JSON.parse(line);
          expect(durationMs).toMatch(/^\d+$/);
          return entry;
        })
        // Each write takes the log lock on its own, in any order.
        .sort((a, b) => a.status.localeCompare(b.status)),
    ).toEqual([
      {
        source: "rigd",
        level: "warn",
        event: "transport.refused",
        route: "command",
        status: "400",
        code: "INVALID_REQUEST",
      },
      {
        source: "rigd",
        level: "warn",
        event: "transport.refused",
        route: "command",
        status: "401",
        code: "UNAUTHORIZED",
      },
      {
        source: "rigd",
        level: "warn",
        event: "transport.refused",
        route: "other",
        status: "404",
        code: "NOT_FOUND",
      },
      {
        source: "rigd",
        level: "warn",
        event: "transport.refused",
        route: "env",
        status: "422",
        code: "ENV_REVISION",
      },
      {
        source: "rigd",
        level: "error",
        event: "transport.failed",
        route: "health",
        status: "500",
        code: "HTTP_FAILURE",
        cause: "Error",
      },
    ]);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
