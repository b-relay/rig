import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { DaemonClient } from "../src/daemon/client";
import type { RuntimeCommand } from "../src/daemon/protocol";
import * as daemon from "../web/server/daemon";
import { LiveRefresh } from "../web/components/live-refresh";
import { mountWithoutDom, textOf } from "./support/hook-harness";

/** What the dashboard polls: `/pulse` and `/usage` through their route handlers, over a stand-in rigd and the real client, and
 * the corner of the page that acts on a pulse. Nothing here waits on a clock. */

const pending = new Set<{ path: string; aborted: Promise<void> }>();
let arrived: () => void = () => {};
let expected = 0;
/** How the stand-in answers a request, by its path or action; undefined holds it until the caller goes. */
let answer: (name: string) => unknown = () => undefined;
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
mock.module("../web/server/daemon", () => ({
  ...real,
  async daemon() {
    return reading ? client : real.daemon();
  },
  async read(command: RuntimeCommand, signal?: AbortSignal) {
    if (monitored && command.action === "monitor") return monitored(command);
    if (reading) return client.command(command, signal);
    return real.read(command as never, signal);
  },
}));
const { GET: pulseRoute } = await import("../web/app/pulse/route");
const { GET: usageRoute } = await import("../web/app/usage/route");
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
