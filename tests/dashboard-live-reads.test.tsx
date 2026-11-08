import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { basic, local } from "./support/dashboard-site";
import { DaemonClient } from "../src/daemon/client";
import type { RuntimeCommand } from "../src/daemon/protocol";
import * as daemon from "../web/server/daemon";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveRefresh } from "../web/components/live-refresh";
import { hasLabel, mountWithoutDom, textOf } from "./support/hook-harness";

/** What the dashboard polls: `/pulse` and `/usage` through their route handlers, over a stand-in rigd and the real client, and
 * the corner of the page that acts on a pulse. Nothing here waits on a clock. */

const pending = new Set<{ path: string; aborted: Promise<void> }>();
let arrived: () => void = () => {};
let expected = 0;
/** How the stand-in answers a request, by its path or action; undefined holds it until the caller goes. */
let answer: (name: string) => unknown = () => undefined;
/** Every request the stand-in received, by path or action, and a gate that holds each answer until it opens. */
let asked: string[] = [];
let gate: Promise<void> | undefined;
const rigd = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const name =
      pathname === "/health"
        ? "health"
        : ((await request.json()) as { action: string }).action;
    asked.push(name);
    // The gate holds the pulse's reads; a command passes.
    if (gate && ["health", "queue", "activity"].includes(name)) await gate;
    const reply = answer(name);
    if (reply !== undefined)
      return Response.json(name === "health" ? reply : { result: reply });
    const aborted = new Promise<void>((resolve) =>
      request.signal.addEventListener("abort", () => resolve()),
    );
    pending.add({ path: name, aborted });
    if (pending.size === expected) arrived();
    await aborted;
    return new Response(null, { status: 499 });
  },
});
const client = new DaemonClient({ port: rigd.port!, token: "test" });
const real = { ...daemon };
let reading = false;
let monitored: ((command: RuntimeCommand) => unknown) | undefined;
/** Whether the request being served holds the key, and how many times rigd was looked for. */
let signedIn = true;
let discoveries = 0;
mock.module("next/headers", () => ({
  headers: async () =>
    new Headers({ ...local(), ...(signedIn && { authorization: basic() }) }),
  cookies: async () => ({ get: () => undefined, set() {} }),
}));
mock.module("../web/server/daemon", () => ({
  ...real,
  async daemon(root?: string) {
    discoveries += 1;
    return reading ? client : real.daemon(root);
  },
  async read(command: RuntimeCommand, signal?: AbortSignal) {
    if (monitored && command.action === "monitor") return monitored(command);
    if (reading) return client.command(command, signal);
    return real.read(command as never, signal);
  },
}));
const { GET: pulseRoute } = await import("../web/app/pulse/route");
const { GET: usageRoute } = await import("../web/app/usage/route");
const { DaemonStatus } = await import("../web/components/top-bar");
const { pulseReadings } = await import("../web/server/pulse");
const { runCommand } = await import("../web/server/actions");
beforeAll(() => {
  reading = true;
});
afterAll(() => {
  reading = false;
  monitored = undefined;
  void rigd.stop(true);
});
afterEach(() => {
  pending.clear();
  answer = () => undefined;
  asked = [];
  gate = undefined;
  signedIn = true;
  discoveries = 0;
});

test("a pulse whose browser goes abandons every read it started, at once", async () => {
  expected = 3;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  const browser = new AbortController();
  const answered = pulseRoute(
    new Request("http://rig.test/pulse", { signal: browser.signal }),
  );
  await reached;
  browser.abort();
  // Each read's own deadline is far off; only the browser's going can close them all here.
  await Promise.all([...pending].map((each) => each.aborted));
  await answered;
  expect([...pending].map((each) => each.path).sort()).toEqual([
    "activity",
    "health",
    "queue",
  ]);
});

test("a pulse whose browser has already gone asks rigd nothing", async () => {
  let asked = 0;
  answer = () => {
    asked += 1;
    return {};
  };
  const response = await pulseRoute(
    new Request("http://rig.test/pulse", { signal: AbortSignal.abort() }),
  );
  expect(response.status).toBe(200);
  expect(asked).toBe(0);
});

test("a pulse left to finish answers its stamp", async () => {
  answer = (name) =>
    name === "health"
      ? { instanceId: "i-1", pid: 42, running: true }
      : name === "queue"
        ? { waiting: 0, operations: [] }
        : { operations: [] };
  const response = await pulseRoute(new Request("http://rig.test/pulse"));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    stamp: "i-1:42|-:0:|0:",
    busy: false,
    down: false,
  });
});

const idle =
  (instanceId = "i-1", newest = "") =>
  (name: string) =>
    name === "health"
      ? { instanceId, pid: 42, running: true }
      : name === "queue"
        ? { waiting: 0, operations: [] }
        : {
            operations: newest
              ? [
                  {
                    id: "op-1",
                    action: "up",
                    outcome: "started",
                    occurredAt: newest,
                  },
                ]
              : [],
          };
const pulseOf = async (signal?: AbortSignal) =>
  (await (
    await pulseRoute(new Request("http://rig.test/pulse", { signal }))
  ).json()) as { stamp: string; busy: boolean; down: boolean };
/** Opens the stand-in's gate once `count` requests have reached it; no clock is involved. */
async function whenAsked(count: number) {
  for (let turn = 0; turn < 10_000 && asked.length < count; turn++)
    await new Promise((resolve) => setImmediate(resolve));
  expect(asked).toHaveLength(count);
}

test("twenty pulses asked while one is in flight share it: rigd is looked for once and asked three things, and every browser gets the same stamp", async () => {
  answer = idle();
  let open = () => {};
  gate = new Promise((resolve) => (open = resolve));
  const pulses = Array.from({ length: 20 }, () => pulseOf());
  await whenAsked(3);
  open();
  const answered = await Promise.all(pulses);
  expect(asked.sort()).toEqual(["activity", "health", "queue"]);
  expect(discoveries).toBe(1);
  expect(new Set(answered.map((each) => each.stamp))).toEqual(
    new Set(["i-1:42|-:0:|0:"]),
  );
});

test("nothing is kept once a pulse answered: an Operation recorded, a restarted rigd and a failed read each show at the next pulse", async () => {
  answer = idle();
  expect((await pulseOf()).stamp).toBe("i-1:42|-:0:|0:");
  answer = idle("i-1", "2026-11-08T10:00:00.000Z");
  expect((await pulseOf()).stamp).toBe(
    "i-1:42|-:0:|1:2026-11-08T10:00:00.000Z",
  );
  answer = idle("i-2", "2026-11-08T10:00:00.000Z");
  expect((await pulseOf()).stamp).toStartWith("i-2:42|");
  // A failed read is not kept either.
  answer = (name) =>
    name === "health" ? { running: "no" } : idle("i-2")(name);
  expect(await pulseOf()).toMatchObject({
    stamp: expect.stringContaining("down:DAEMON_PROTOCOL"),
  });
  answer = idle("i-2");
  expect((await pulseOf()).stamp).toBe("i-2:42|-:0:|0:");
  expect(discoveries).toBe(5);
});

test("one browser going leaves the shared read to the others; it is abandoned when the last goes", async () => {
  expected = 3;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  const first = new AbortController();
  const second = new AbortController();
  const pulses = [pulseOf(first.signal), pulseOf(second.signal)];
  await reached;
  first.abort();
  for (let turn = 0; turn < 20; turn++)
    await new Promise((resolve) => setImmediate(resolve));
  // The other browser still waits, so rigd's answers are still wanted.
  let abandoned = 0;
  for (const each of pending) void each.aborted.then(() => abandoned++);
  for (let turn = 0; turn < 20; turn++)
    await new Promise((resolve) => setImmediate(resolve));
  expect(abandoned).toBe(0);
  second.abort();
  await Promise.all([...pending].map((each) => each.aborted));
  await Promise.all(pulses);
  expect(asked.sort()).toEqual(["activity", "health", "queue"]);
});

test("a browser that goes is answered at once, cancelled, before the read it shared answers the one still waiting", async () => {
  answer = idle();
  let open = () => {};
  gate = new Promise((resolve) => (open = resolve));
  const leaving = new AbortController();
  let left: { stamp: string } | undefined;
  const gone = pulseOf(leaving.signal).then((pulse) => (left = pulse));
  let stayed: { stamp: string } | undefined;
  const staying = pulseOf().then((pulse) => (stayed = pulse));
  await whenAsked(3);
  leaving.abort();
  await gone;
  expect(left!.stamp).toBe("down:CANCELLED|?|?");
  expect(stayed).toBeUndefined();
  open();
  await staying;
  expect(stayed!.stamp).toBe("i-1:42|-:0:|0:");
  expect(asked).toHaveLength(3);
});

test("a command from the site that ends while a pulse read is in flight leaves that read to those sharing it: the next one reads rigd afresh", async () => {
  answer = (name) =>
    name === "up" ? { operationId: "op-1", outcome: "started" } : idle()(name);
  let open = () => {};
  gate = new Promise((resolve) => (open = resolve));
  const begun = pulseReadings();
  await whenAsked(3);
  expect((await runCommand({ action: "up", project: "pantry" })).ok).toBe(true);
  const after = pulseReadings();
  await whenAsked(7);
  open();
  await Promise.all([begun, after]);
  expect(asked.filter((name) => name === "queue")).toHaveLength(2);
  // Without a command, a read asked meanwhile still shares the one in flight.
  asked = [];
  gate = new Promise((resolve) => (open = resolve));
  const shared = [pulseReadings(), pulseReadings()];
  await whenAsked(3);
  open();
  await Promise.all(shared);
  expect(asked.sort()).toEqual(["activity", "health", "queue"]);
});

test("a request with no session is refused on its own, even while a signed-in one's read is in flight", async () => {
  answer = idle();
  let open = () => {};
  gate = new Promise((resolve) => (open = resolve));
  const signed = pulseOf();
  await whenAsked(3);
  signedIn = false;
  const stranger = await pulseOf();
  expect(stranger.stamp).toBe("down:SIGN_IN_REQUIRED|?|?");
  open();
  expect((await signed).stamp).toBe("i-1:42|-:0:|0:");
  expect(asked).toHaveLength(3);
});

test("a health reply rigd should not have sent is a fault: the pulse does not call it an outage, and the corner names it with its hint", async () => {
  answer = (name) =>
    name === "health"
      ? { running: "not as rigd says it" }
      : name === "queue"
        ? { waiting: 0, operations: [] }
        : { operations: [] };
  const response = await pulseRoute(new Request("http://rig.test/pulse"));
  expect(await response.json()).toMatchObject({
    stamp: expect.stringContaining("down:DAEMON_PROTOCOL"),
    down: false,
  });
  const mark = await DaemonStatus();
  expect(renderToStaticMarkup(mark)).toContain("rigd: DAEMON_PROTOCOL");
  expect(renderToStaticMarkup(mark)).not.toContain("rigd unreachable");
  expect(renderToStaticMarkup(mark)).toContain("the same version");
});

const series = (scope: string, target?: string) => ({
  series: { scope, ...(target ? { target, targetKind: "preview" } : {}) },
  summary: { low: 0, high: 0, average: 0, median: 0, p95: 0 },
  points: [],
});
const usage = async (query: unknown) =>
  (await (
    await usageRoute(
      new Request(
        `http://rig.test/usage?q=${encodeURIComponent(JSON.stringify(query))}`,
      ),
    )
  ).json()) as {
    ok: boolean;
    failure?: { code: string };
    value?: { series: { series: { scope: string } }[] };
  };
const MONITOR = {
  project: "probe",
  targets: ["working", "stable"],
  since: 1000,
  until: 2000,
  step: 60,
  sampledEvery: 5,
  series: [
    { ...series("project") },
    { ...series("target", "working") },
    { ...series("target", "feature") },
    {
      ...series("component", "working"),
      series: {
        scope: "component",
        target: "working",
        component: "web",
        componentKind: "service",
      },
    },
  ],
};

test.each([
  ["missing", {}],
  ["empty", { target: "" }],
  ["overlong", { target: "x".repeat(64) }],
  ["of the wrong type", { target: -1 }],
])(
  "a Target selector that is %s is refused before rigd is read",
  async (_what, selector) => {
    monitored = () => {
      throw new Error("rigd should not be read.");
    };
    expect(
      await usage({ project: "probe", range: "1h", ...selector }),
    ).toMatchObject({ ok: false, failure: { code: "INVALID_REQUEST" } });
  },
);

test("a well-formed Target the Project neither has nor had in the range is refused, not an empty Component chart", async () => {
  monitored = () => MONITOR;
  expect(
    await usage({ project: "probe", range: "1h", target: "absent" }),
  ).toMatchObject({ ok: false, failure: { code: "TARGET_MISSING" } });
});

test.each([
  ["all", 0],
  ["a Target the Project has", 1],
  ["one it has that was never sampled", 0],
  ["one whose history remains", 0],
])("%s is charted", async (what, components) => {
  monitored = () => MONITOR;
  const target = {
    all: "all",
    "a Target the Project has": "working",
    "one it has that was never sampled": "stable",
    "one whose history remains": "feature",
  }[what]!;
  const reply = await usage({ project: "probe", range: "1h", target });
  expect(reply.ok).toBe(true);
  expect(
    reply.value!.series.filter((each) => each.series.scope === "component")
      .length,
  ).toBe(components);
});

// The corner of the page: a pulse decides whether the page is read again.
function corner() {
  const previousDocument = (globalThis as { document?: unknown }).document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousFetch = globalThis.fetch;
  const previousInterval = globalThis.setInterval;
  const handlers: Record<string, () => void> = {};
  let pulse: unknown;
  const listen = {
    addEventListener(name: string, handler: () => void) {
      handlers[name] = handler;
    },
    removeEventListener() {},
  };
  (globalThis as { document?: unknown }).document = {
    visibilityState: "visible",
    ...listen,
  };
  (globalThis as { window?: unknown }).window = { ...listen };
  globalThis.fetch = (async () =>
    Response.json(pulse)) as unknown as typeof fetch;
  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
  const mounted = mountWithoutDom(LiveRefresh);
  mounted.render({ status: "rigd is up, as last read" });
  return {
    mounted,
    async beat(next: unknown) {
      pulse = next;
      handlers.visibilitychange!();
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve();
        mounted.render();
      }
    },
    restore() {
      (globalThis as { document?: unknown }).document = previousDocument;
      (globalThis as { window?: unknown }).window = previousWindow;
      globalThis.fetch = previousFetch;
      globalThis.setInterval = previousInterval;
    },
  };
}

test("rigd going down leaves the page as it last read, says so in the corner, and redraws once rigd answers", async () => {
  const page = corner();
  try {
    await page.beat({ stamp: "a", busy: false, down: false });
    expect(page.mounted.refreshes.count).toBe(1);
    expect(textOf(page.mounted.tree)).toContain("rigd is up");
    await page.beat({ stamp: "down:DAEMON_MISSING", busy: false, down: true });
    await page.beat({ stamp: "down:DAEMON_TIMEOUT", busy: false, down: true });
    // Neither a changed stamp nor a long spell replaces the page with a failure.
    expect(page.mounted.refreshes.count).toBe(1);
    // What the page last read of rigd never stands beside that.
    expect(textOf(page.mounted.tree)).toContain("rigd unreachable");
    expect(textOf(page.mounted.tree)).not.toContain("rigd is up");
    await page.beat({ stamp: "b", busy: false, down: false });
    expect(page.mounted.refreshes.count).toBe(2);
    expect(textOf(page.mounted.tree)).not.toContain("rigd unreachable");
    expect(textOf(page.mounted.tree)).toContain("rigd is up");
  } finally {
    page.restore();
  }
});

test("a fault keeps the page redrawing and Refresh now offered, and is not said to be an outage", async () => {
  const page = corner();
  try {
    await page.beat({ stamp: "a", busy: false, down: false });
    await page.beat({
      stamp: "down:DAEMON_PROTOCOL",
      busy: false,
      down: false,
    });
    expect(page.mounted.refreshes.count).toBe(2);
    expect(textOf(page.mounted.tree)).not.toContain("rigd unreachable");
    expect(hasLabel(page.mounted.tree, "Refresh now")).toBe(true);
  } finally {
    page.restore();
  }
});
