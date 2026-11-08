import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedCaddyWorld } from "./support/managed-caddy-double";
import { currentGeneration } from "../src/adapters/proxy-generation";
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

// #838, #568: what the proxy report and doctor read of a generation record is checked as Rig's Caddy checks it; one that is
// not a record gives no evidence, as one that is not JSON does, and says why.
test.each([
  ["null", "null"],
  ["a list", "[]"],
  ["malformed JSON", "{"],
])(
  "the generation a report reads from a record holding %s takes nothing from it and names it damaged",
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
    const { damaged, ...evidence } = (await currentGeneration(w.root))!;
    expect(evidence).toMatchObject({ id: "g001", customRoutes: [] });
    expect(evidence).not.toHaveProperty("proxy");
    expect(evidence).not.toHaveProperty("dashboard");
    expect(evidence).toHaveProperty("adapted");
    expect(damaged).toEqual({ metadata: expect.any(Error) });
    expect(damaged!.metadata).toMatchObject(
      corrupt(
        path,
        "Rig cannot read the record of Caddy generation g001.",
        "Delete it, then run rig proxy reload: Rig builds a new generation from Host config.",
      ),
    );
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

test.each([
  ["adapted.json", "running"],
  ["adapted.json", "stopped by a restart it never saw through"],
])(
  "deleting a refused %s repairs it for the next rigd too, whose recovery restarts a Caddy %s",
  async (file, before) => {
    const w = await world();
    await w.caddy.router.apply(app());
    const paths = proxyPaths(w.root);
    // The rigd that met the refusal ended without recording a clean stop, and the owner deleted the file, as its hint says.
    await rm(join(paths.generations, "g001", file));
    if (before !== "running") {
      await writeFile(paths.restore, "{}\n");
      w.control.state = "stopped";
      w.control.reachable = false;
    }
    const next = w.reopen();
    // The reload succeeds, whether its recovery or the reload itself built the replacement.
    await next.republish();
    expect(await w.current()).not.toBe("g001");
    expect(await Bun.file(join(paths.current, "adapted.json")).exists()).toBe(
      true,
    );
    expect(await Bun.file(paths.restore).exists()).toBe(false);
    expect(w.control.state).toBe("running");
    await next.router.apply(app("127.0.0.1:3002"));
    expect(w.servedRoutes()).toContain("127.0.0.1:3002");
  },
);

test.each(["running", "stopped by a restart it never saw through"])(
  "when no replacement for a missing adapted.json can be built, recovery of a Caddy %s is refused before any restart, and the next try recovers",
  async (before) => {
    const w = await world();
    await w.caddy.router.apply(app());
    const paths = proxyPaths(w.root);
    await rm(join(paths.generations, "g001", "adapted.json"));
    if (before !== "running") {
      await writeFile(paths.restore, "{}\n");
      w.control.state = "stopped";
      w.control.reachable = false;
    }
    const serving = w.servedRoutes();
    // Caddy refuses the replacement, so there is still nothing to start from.
    w.failures.validate = "bad validation";
    const next = w.reopen();
    await expect(next.served()).rejects.toMatchObject({
      code: "PROXY_RECOVERY",
      message:
        "Rig's Caddy could not be given a configuration to start from before its restart.",
    });
    // No restart that could only fail: Caddy is as it was, and the obligation an earlier restart left stays.
    expect(w.control.restarts).toBe(0);
    expect(w.control.state).toBe(before === "running" ? "running" : "stopped");
    expect(w.servedRoutes()).toBe(serving);
    expect(await w.current()).toBe("g001");
    expect(await Bun.file(paths.restore).exists()).toBe(before !== "running");
    // Once Caddy takes the replacement, the next try recovers.
    delete w.failures.validate;
    expect(await next.served()).toBeDefined();
    expect(w.control.restarts).toBe(1);
    expect(w.control.state).toBe("running");
    expect(await w.current()).not.toBe("g001");
    expect(await Bun.file(paths.restore).exists()).toBe(false);
    expect(w.servedRoutes()).toContain("127.0.0.1:3001");
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
  [
    "a pid past 32 bits, which the kernel query would read as this process",
    `{"pid":${2 ** 32 + process.pid}}`,
  ],
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

test("doctor reports a Caddy process record it cannot read as a failing check with its file and repair, and inspects the rest", async () => {
  const root = await freshRoot();
  const paths = proxyPaths(root);
  await mkdir(paths.caddy, { recursive: true });
  await writeFile(paths.processRecord, '{"pid":0}');
  const checks = await inspectManagedProxy(root, settings(), "process");
  expect(checks.find((check) => check.name === "proxy-process")).toEqual({
    name: "proxy-process",
    ok: false,
    message: "Rig cannot read the process record of its Caddy.",
    reason: "proxy-state-corrupt",
    hint: corrupt(
      paths.processRecord,
      "",
      `If Rig's Caddy still runs (it answers on ${paths.socket}), stop it; then delete the record and run the command again.`,
    ).hint,
  });
  // The checks before it and after it are all still there.
  expect(checks.map((check) => check.name)).toEqual(
    expect.arrayContaining([
      "proxy-token",
      "proxy-binary",
      "proxy-process",
      "proxy-config",
    ]),
  );
});

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

// #568: a file of the current generation that is missing or damaged is named by the doctor check that relies on it, which
// claims nothing it cannot compare; the repair it names makes the generation complete again.
const RELOAD =
  "run rig proxy reload: Rig builds a new generation from Host config.";
test.each([
  ["generation.json", "missing", "proxy-settings", "proxy-settings-unknown"],
  ["generation.json", "not JSON", "proxy-settings", "proxy-settings-unknown"],
  ["adapted.json", "missing", "proxy-serving", "proxy-serving-unknown"],
  ["adapted.json", "not JSON", "proxy-serving", "proxy-serving-unknown"],
])(
  "doctor names a current generation's %s that is %s, the other checks still report, and the repair it names clears it",
  async (file, damage, check, reason) => {
    const w = await world();
    await w.caddy.router.apply(app());
    const inspect = async (reachable: boolean) =>
      await inspectManagedProxy(w.root, settings(), "process", {
        admin: {
          reachable: async () => reachable,
          config: async () => w.control.loaded,
          stop: async () => true,
          load: async () => undefined,
        },
        job: {
          state: async () => (reachable ? "running" : "stopped"),
          description: "test",
        },
      });
    const failing = async () =>
      (await inspect(true)).filter((each) => !each.ok);
    // Intact, nothing fails.
    expect(await failing()).toEqual([]);
    const path = join(w.root, "caddy", "generations", "g001", file);
    await (damage === "missing" ? rm(path) : writeFile(path, "{"));
    const what =
      file === "generation.json"
        ? "the record of Caddy generation g001"
        : "the configuration Caddy generation g001 was validated as";
    const expected = {
      name: check,
      ok: false,
      message: expect.stringContaining(`Rig cannot read ${what}.`),
      reason,
      hint:
        damage === "missing"
          ? `${path} is missing. To make the generation complete again, ${RELOAD}`
          : expect.stringMatching(
              new RegExp(
                `^${escape(path)} is not valid JSON.* Delete it, then ${escape(RELOAD)}$`,
              ),
            ),
    };
    // Reported whether or not Caddy answers, and only by the check that relies on the file.
    for (const reachable of [true, false]) {
      const checks = await inspect(reachable);
      expect(checks.filter((each) => !each.ok)).toEqual([
        ...(reachable
          ? []
          : [expect.objectContaining({ name: "proxy-process", ok: false })]),
        expected,
      ]);
      expect(checks.map((each) => each.name)).toEqual(
        expect.arrayContaining([
          "proxy-binary",
          "proxy-process",
          "proxy-settings",
          ...(reachable || check === "proxy-serving" ? ["proxy-serving"] : []),
        ]),
      );
    }
    // The repair the hint names.
    if (damage === "not JSON") await rm(path);
    expect(await w.caddy.republish()).toEqual({ published: true });
    expect(await w.current()).not.toBe("g001");
    expect(await failing()).toEqual([]);
  },
);

test("a generation record without settings this Rig reads is compared by their digest: served while Host config matches it, pending once it changes", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const path = join(w.root, "caddy", "generations", "g001", "generation.json");
  const { proxy: _, ...digestOnly } = JSON.parse(await Bun.file(path).text());
  await writeFile(path, JSON.stringify(digestOnly));
  const proxySettings = async (requested: ReturnType<typeof settings>) =>
    (
      await inspectManagedProxy(w.root, requested, "process", {
        admin: {
          reachable: async () => true,
          config: async () => w.control.loaded,
          stop: async () => true,
          load: async () => undefined,
        },
        job: { state: async () => "running", description: "test" },
      })
    ).find((check) => check.name === "proxy-settings");
  expect(await proxySettings(settings())).toEqual({
    name: "proxy-settings",
    ok: true,
    message: "Rig's Caddy serves the proxy section of config.yaml.",
  });
  const edited = { routes: { "own.example.test": 3005 } };
  expect(await proxySettings(settings(edited))).toMatchObject({
    ok: false,
    reason: "proxy-settings-pending",
    hint: "Run rig proxy reload to apply it.",
  });
  w.setSettings(edited);
  expect(await w.caddy.republish()).toEqual({ published: true });
  expect(await proxySettings(settings(edited))).toMatchObject({ ok: true });
});
