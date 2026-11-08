import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedCaddyWorld } from "./support/managed-caddy-double";
import { proxyReport } from "../src/adapters/proxy-report";
import { inspectManagedProxy } from "../src/adapters/proxy-inspection";
import { parseHostConfig } from "../src/config";
import { proxyPaths } from "../src/domain/managed-proxy";
import { createCaddyAdmin } from "../src/providers/caddy-admin";
import { createProcessCaddyJob } from "../src/providers/caddy-job";

// #617: what Rig reads back of its Caddy (the records it keeps, and what Caddy prints and answers) is checked before it is
// used. A document of the wrong shape is a tagged refusal naming the file, never a TypeError or a value taken as valid.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function world(...args: Parameters<typeof managedCaddyWorld>) {
  const made = await managedCaddyWorld(...args);
  roots.push(made.root);
  return made;
}
async function freshRoot() {
  const root = await mkdtemp(join(tmpdir(), "rig-records-"));
  roots.push(root);
  return root;
}
const app = (upstream = "127.0.0.1:3001") => ({
  key: "app",
  sites: [
    { hostname: "app.example.test", routes: [{ prefix: "/", upstream }] },
  ],
});
const settings = (proxy: Record<string, unknown> = {}) =>
  parseHostConfig({ proxy: { caddy: "/usr/local/bin/caddy", ...proxy } })
    .proxy!;
/** A refusal of the record at `path`, with the repair its hint ends with. */
const corrupt = (path: string, message: string, repair: string) => ({
  code: "PROXY_STATE_CORRUPT",
  message,
  hint: expect.stringMatching(
    new RegExp(
      `^${escape(path)} (has an invalid value at|is not valid JSON).* ${escape(repair)}$`,
    ),
  ),
  details: { path },
});
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.each([
  ["null", "null"],
  ["a list", "[]"],
  ["text", '"text"'],
])(
  "caddy adapt printing %s is refused as the configuration it is, and nothing is switched",
  async (_, printed) => {
    const w = await world();
    await w.caddy.router.apply(app());
    w.control.adaptPrints = printed;
    await expect(
      w.caddy.router.apply(app("127.0.0.1:3002")),
    ).rejects.toMatchObject({
      code: "ROUTE_VALIDATE",
      message:
        "Caddy rejected the updated routes: caddy adapt printed JSON that is not a Caddy configuration",
    });
    expect(await w.current()).toBe("g001");
    expect(w.servedRoutes()).toContain("127.0.0.1:3001");
  },
);

test.each([
  ["null", "null"],
  [
    "a number for its settings digest",
    '{"id":"g001","ca":"internal","settings":5,"createdAt":"x"}',
  ],
  [
    "a dashboard that is no route",
    '{"id":"g001","ca":"internal","settings":"d","createdAt":"x","dashboard":"rig.example.test"}',
  ],
  ["malformed JSON", "{"],
])(
  "a generation record holding %s is refused before any change, and deleting it is the repair",
  async (_, content) => {
    const w = await world();
    await w.caddy.router.apply(app());
    const path = join(
      w.root,
      "caddy",
      "generations",
      "g001",
      "generation.json",
    );
    await writeFile(path, content);
    const refusal = corrupt(
      path,
      "Rig cannot read the record of Caddy generation g001.",
      "Delete it, then run rig proxy reload: Rig builds a new generation from Host config.",
    );
    await expect(
      w.caddy.router.apply(app("127.0.0.1:3002")),
    ).rejects.toMatchObject(refusal);
    await expect(w.caddy.republish()).rejects.toMatchObject(refusal);
    expect(await w.current()).toBe("g001");
    // The repair the hint names.
    await rm(path);
    expect(await w.caddy.republish()).toEqual({ published: true });
    await w.caddy.router.apply(app("127.0.0.1:3002"));
    expect(w.servedRoutes()).toContain("127.0.0.1:3002");
  },
);

test.each([
  ["null", "null"],
  ["a list", "[]"],
  ["apps that are no object", '{"apps":"http"}'],
  ["malformed JSON", "{"],
])(
  "a generation's adapted configuration holding %s is refused, and deleting it is the repair",
  async (_, content) => {
    const w = await world();
    await w.caddy.router.apply(app());
    const path = join(w.root, "caddy", "generations", "g001", "adapted.json");
    await writeFile(path, content);
    const refusal = corrupt(
      path,
      "Rig cannot read the configuration Caddy generation g001 was validated as.",
      "Delete it, then run rig proxy reload: Rig builds a new generation from Host config.",
    );
    await expect(w.caddy.republish()).rejects.toMatchObject(refusal);
    expect(await w.current()).toBe("g001");
    await rm(path);
    expect(await w.caddy.republish()).toEqual({ published: true });
    expect(await w.current()).toBe("g002");
  },
);

test("a refusal record of the wrong shape is refused by rig proxy and reported by doctor, never shown as the reason", async () => {
  const w = await world({ routes: { "own.example.test": 3005 } });
  await w.caddy.router.apply(app());
  const requested = settings({
    routes: { "own.example.test": 3005, "app.example.test": 3006 },
  });
  w.setSettings({
    routes: { "own.example.test": 3005, "app.example.test": 3006 },
  });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
  });
  const path = join(w.root, "caddy", "settings-rejected.json");
  const recorded = JSON.parse(await Bun.file(path).text());
  // The digest still matches, so before this the reason was printed as whatever the record held.
  await writeFile(path, JSON.stringify({ ...recorded, reason: { at: 1 } }));
  const refusal = corrupt(
    path,
    "Rig cannot read why it refused the proxy section of Host config.",
    "Delete it, then run rig proxy reload: Rig records the refusal again if it still refuses them.",
  );
  await expect(
    proxyReport({
      root: w.root,
      requested,
      job: { state: async () => "running" } as never,
      admin: { reachable: async () => true } as never,
      targets: [],
    }),
  ).rejects.toMatchObject(refusal);
  const checks = await inspectManagedProxy(w.root, requested, "process", {
    admin: {
      reachable: async () => true,
      config: async () => w.control.loaded,
      stop: async () => true,
      load: async () => undefined,
    },
    job: { state: async () => "running", description: "test" },
  });
  expect(checks.find((check) => check.name === "proxy-settings")).toEqual({
    name: "proxy-settings",
    ok: false,
    message: refusal.message,
    reason: "proxy-settings-unknown",
    hint: refusal.hint,
  });
  // A valid record still reads as before.
  await writeFile(path, JSON.stringify(recorded));
  const report = await proxyReport({
    root: w.root,
    requested,
    job: { state: async () => "running" } as never,
    admin: { reachable: async () => true } as never,
    targets: [],
  });
  expect(report).toMatchObject({
    pending: { code: "ROUTE_CONFLICT", reason: recorded.reason },
  });
});

test("Caddy's admin API answering JSON that is not a configuration is PROXY_PROTOCOL; a configuration, null and no JSON read as before", async () => {
  const root = await freshRoot();
  const socket = join(root, "admin.sock");
  let body = "";
  const server = Bun.serve({
    unix: socket,
    fetch: () =>
      new Response(body, { headers: { "Content-Type": "application/json" } }),
  });
  try {
    const admin = createCaddyAdmin(socket);
    for (const reply of ["[]", '"text"', "7", '{"apps":[]}']) {
      body = reply;
      await expect(admin.config()).rejects.toMatchObject({
        code: "PROXY_PROTOCOL",
        message:
          "Rig's Caddy answered GET /config/ with something other than a Caddy configuration.",
        hint: `Check that ${socket} is the admin socket of Rig's Caddy, then run rigd install, which restarts it.`,
        details: { socket },
      });
    }
    body = '{"apps":{"http":{"servers":{}}},"admin":{"listen":"x"}}';
    expect(await admin.config()).toEqual({
      apps: { http: { servers: {} } },
      admin: { listen: "x" },
    });
    body = "null";
    expect(await admin.config()).toBeNull();
    // A reply that is not JSON at all is no answer, as before.
    body = "{";
    expect(await admin.config()).toBeUndefined();
    // Doctor reports such a reply instead of failing.
    body = "[]";
    const checks = await inspectManagedProxy(root, settings(), "process", {
      admin,
      job: { state: async () => "running", description: "test" },
    });
    expect(checks.find((check) => check.name === "proxy-serving")).toEqual({
      name: "proxy-serving",
      ok: false,
      message:
        "Rig's Caddy answered GET /config/ with something other than a Caddy configuration.",
      reason: "proxy-unreachable",
      hint: `Check that ${socket} is the admin socket of Rig's Caddy, then run rigd install, which restarts it.`,
    });
  } finally {
    await server.stop(true);
  }
});

test.each([
  ["null", "null"],
  ["pid 0, which signals the whole process group", '{"pid":0}'],
  ["a negative pid", '{"pid":-1}'],
  ["a pid that is text", '{"pid":"1"}'],
  ["a start time that is no text", `{"pid":${process.pid},"startedAt":5}`],
  ["malformed JSON", '{"pid":'],
])(
  "a Caddy process record holding %s is refused before its pid reaches a signal",
  async (_, content) => {
    const root = await freshRoot();
    const paths = proxyPaths(root);
    await mkdir(paths.caddy, { recursive: true });
    await writeFile(paths.processRecord, content);
    const stops: string[] = [];
    const job = createProcessCaddyJob({
      root,
      paths,
      userHome: root,
      admin: {
        reachable: async () => false,
        config: async () => undefined,
        stop: async () => (stops.push("stop"), true),
        load: async () => undefined,
      },
      deadlineMs: 1,
    });
    const signals: unknown[] = [];
    const kill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      signals.push([pid, signal]);
      return true;
    }) as typeof process.kill;
    try {
      const refusal = corrupt(
        paths.processRecord,
        "Rig cannot read the process record of its Caddy.",
        `If Rig's Caddy still runs (it answers on ${paths.socket}), stop it; then delete the record and run the command again.`,
      );
      await expect(job.state()).rejects.toMatchObject(refusal);
      await expect(job.remove()).rejects.toMatchObject(refusal);
      await expect(job.restart()).rejects.toMatchObject(refusal);
    } finally {
      process.kill = kill;
    }
    expect(signals).toEqual([]);
    // Asking Caddy to stop through its socket needs no pid, so the stops still did; nothing started a new Caddy.
    expect(stops).toEqual(["stop", "stop"]);
    expect(await Bun.file(paths.processRecord).text()).toBe(content);
  },
);

test("a valid Caddy process record still reads as before, and none is a stopped Caddy", async () => {
  const root = await freshRoot();
  const paths = proxyPaths(root);
  await mkdir(paths.caddy, { recursive: true });
  const job = createProcessCaddyJob({
    root,
    paths,
    userHome: root,
    admin: {
      reachable: async () => false,
      config: async () => undefined,
      stop: async () => true,
      load: async () => undefined,
    },
  });
  expect(await job.state()).toBe("stopped");
  // An older rigd's record, without a start time: the pid is alive, so it cannot be verified.
  await writeFile(paths.processRecord, JSON.stringify({ pid: process.pid }));
  expect(await job.state()).toBe("unknown");
});
