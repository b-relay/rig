import { expect, test } from "bun:test";
import type { ManagedComponent, TargetPlan } from "../src/config/types";
import type { TargetRecord } from "../src/domain/runtime";
import type { ProcessObservation } from "../src/providers/contracts";
import {
  boundedObservations,
  type ObservationDeadline,
} from "../src/runtime/bounded-observations";
import {
  createTargetLifecycle,
  type TargetEffects,
  withStops,
} from "../src/runtime/lifecycle";
import {
  ROUTE_LOOK_INTERVAL_MS,
  createRouteGuard,
  type RouteGuard,
} from "../src/runtime/route-guard";

/** The guard on its own, over a scripted lifecycle and observations and a deadline only the test fires. */

const WEB = 4001,
  API = 4000;

function target(ports = { web: WEB, api: API }): TargetRecord {
  const service = (name: "web" | "api"): ManagedComponent => ({
    name,
    kind: "managed",
    command: name,
    port: ports[name],
    readyTimeout: 1,
    env: {},
    dependsOn: [],
  });
  return {
    id: "t1",
    kind: "working",
    name: "stable",
    plan: {
      domain: "app.test",
      proxy: {
        upstream: "web",
        routes: [
          { prefix: "/api", service: "api", port: ports.api },
          { prefix: "/", service: "web", port: ports.web },
        ],
      },
      components: [service("api"), service("web")],
    } as unknown as TargetPlan,
  } as unknown as TargetRecord;
}

/** A promise the test settles, and one that says the code under test reached it. */
function gate() {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return { open, reach, opened, reached };
}

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const waiting = new Set<() => void>();
  let ended: (() => void) | undefined;
  const deadline: ObservationDeadline = {
    schedule(ms, expire) {
      if (ms !== ROUTE_LOOK_INTERVAL_MS) return () => {};
      waiting.add(expire);
      ended?.();
      return () => waiting.delete(expire);
    },
  };
  const live = new Set([WEB, API]);
  /** What each Service is seen as, or a promise of that which ignores cancellation. */
  const seen = new Map<
    string,
    ProcessObservation | Promise<ProcessObservation>
  >();
  const signals = new Map<string, AbortSignal>();
  /** Each read of the live paths, and each withholding asked of the proxy, in order. */
  const events: string[] = [];
  const hooks: { withhold?: () => Promise<void>; read?: () => Promise<void> } =
    {};
  const said: string[] = [];
  const lifecycle = {
    async livePorts() {
      events.push("read");
      await hooks.read?.();
      return new Set(live);
    },
    async withholdPorts(_target: TargetRecord, ports: ReadonlySet<number>) {
      events.push(`withhold ${[...ports].sort().join(",")} begun`);
      await hooks.withhold?.();
      for (const port of ports) live.delete(port);
      events.push("withhold done");
    },
  };
  const observed: string[] = [];
  const guard = createRouteGuard(
    {
      lifecycle: lifecycle as never,
      observations: {
        async process(
          _target: TargetRecord,
          component: { name: string },
          signal: AbortSignal,
        ) {
          observed.push(component.name);
          signals.set(component.name, signal);
          return (await seen.get(component.name)) ?? { state: "running" };
        },
      } as never,
      observationBudgetMs: 2000,
      observationDeadline: deadline,
      async diagnostic({ outcome }) {
        said.push(outcome);
      },
    },
    { operationId: "op1", action: "deploy" },
  );
  return {
    guard,
    waiting,
    live,
    seen,
    signals,
    events,
    hooks,
    said,
    observed,
    /** Fires the look waiting, resolving once the next is scheduled. */
    async look() {
      const [fire] = waiting;
      if (!fire) throw new Error("no look is waiting");
      waiting.delete(fire);
      const next = new Promise<void>((resolve) => (ended = resolve));
      fire();
      await next;
    },
    /** Fires the look waiting and returns at once, leaving it in flight. */
    startLook() {
      const [fire] = waiting;
      if (!fire) throw new Error("no look is waiting");
      waiting.delete(fire);
      fire();
    },
  };
}

test("a guard not watching does nothing: no look is ever scheduled, a change runs at once, and release ends at once", async () => {
  const f = fixture();
  expect(await f.guard.exclusive(async () => "changed")).toBe("changed");
  expect(f.waiting.size).toBe(0);
  await f.guard.release();
  expect(f.events).toEqual([]);
});

test("a look with nothing live observes nothing and withholds nothing", async () => {
  expect(ROUTE_LOOK_INTERVAL_MS).toBe(1000);
  const f = fixture();
  f.live.clear();
  f.guard.watch(target());
  await f.look();
  expect(f.events).toEqual(["read"]);
  expect(f.observed).toEqual([]);
});

test("one look runs at a time: none is scheduled until the one in flight ends", async () => {
  const f = fixture();
  f.guard.watch(target());
  const answer = gate();
  f.hooks.read = () => answer.opened;
  f.startLook();
  await settled();
  expect(f.waiting.size).toBe(0);
  answer.open();
  await settled();
  expect(f.waiting.size).toBe(1);
  await f.guard.release();
});

test("a second watch starts no second loop", async () => {
  const f = fixture();
  f.guard.watch(target());
  f.guard.watch(target());
  expect(f.waiting.size).toBe(1);
  await f.guard.release();
  expect(f.waiting.size).toBe(0);
});

test("a section ends a look waiting on the provider, whose late answer is dropped, and the next look reads the paths again", async () => {
  const f = fixture();
  f.guard.watch(target());
  let answerLate!: (seen: ProcessObservation) => void;
  f.seen.set(
    "web",
    new Promise<ProcessObservation>((resolve) => (answerLate = resolve)),
  );
  f.startLook();
  await settled();
  expect(f.observed).toContain("web");

  // The provider never answers, and no budget ends here: only the section's abort can end the look.
  const order: string[] = [];
  await f.guard.exclusive(async () => {
    order.push(`aborted ${f.signals.get("web")!.aborted}`);
  });
  expect(order).toEqual(["aborted true"]);

  answerLate({ state: "stopped" });
  await settled();
  expect(f.events).toEqual(["read"]);

  // Asking afresh, the look sees the Service as it is now.
  f.seen.delete("web");
  await f.look();
  expect(f.events).toEqual(["read", "read"]);
  await f.guard.release();
});

test("a section keeps the answers already in: a look it ended still withholds a Service it saw stopped, before the change", async () => {
  const f = fixture();
  f.guard.watch(target());
  f.seen.set("web", { state: "stopped" });
  f.seen.set("api", new Promise<ProcessObservation>(() => {}));
  f.startLook();
  await settled();
  expect(f.observed.sort()).toEqual(["api", "web"]);
  await f.guard.exclusive(async () => {
    f.events.push("change");
  });
  expect(f.events).toEqual([
    "read",
    `withhold ${WEB} begun`,
    "withhold done",
    "change",
  ]);
  await f.guard.release();
});

test("a section ends a look still reading the live paths, however long the read takes", async () => {
  const f = fixture();
  f.guard.watch(target());
  const read = gate();
  f.hooks.read = () => read.opened;
  f.startLook();
  await settled();
  await f.guard.exclusive(async () => {});
  expect(f.observed).toEqual([]);
  read.open();
  await settled();
  expect(f.observed).toEqual([]);
  await f.guard.release();
});

test("a section waits for a withholding the look has begun: a route mutation finishes before the change starts", async () => {
  const f = fixture();
  f.guard.watch(target());
  f.seen.set("web", { state: "stopped" });
  const held = gate();
  f.hooks.withhold = () => {
    held.reach();
    return held.opened;
  };
  f.startLook();
  await held.reached;
  const change = f.guard.exclusive(async () => {
    f.events.push("change");
  });
  await settled();
  expect(f.events).toEqual(["read", `withhold ${WEB} begun`]);
  held.open();
  await change;
  expect(f.events).toEqual([
    "read",
    `withhold ${WEB} begun`,
    "withhold done",
    "change",
  ]);
  await f.guard.release();
});

test("no look starts while a section runs, and one is scheduled when it ends, even when it fails", async () => {
  const f = fixture();
  f.guard.watch(target());
  const inSection = f.guard.exclusive(async () => {
    expect(f.waiting.size).toBe(0);
    throw new Error("the change failed");
  });
  await expect(inSection).rejects.toThrow("the change failed");
  expect(f.waiting.size).toBe(1);
  await f.guard.release();
});

test("a section may run inside another, and looks stay off until the outer one ends", async () => {
  const f = fixture();
  f.guard.watch(target());
  const value = await f.guard.exclusive(async () => {
    const inner = await f.guard.exclusive(async () => "inner");
    expect(f.waiting.size).toBe(0);
    return inner;
  });
  expect(value).toBe("inner");
  expect(f.waiting.size).toBe(1);
  await f.guard.release();
});

test("a proxy that refuses is said once, and tried again by each look until it answers", async () => {
  const f = fixture();
  f.guard.watch(target());
  f.seen.set("web", { state: "stopped" });
  f.hooks.withhold = async () => {
    throw new Error("caddy is down");
  };
  await f.look();
  await f.look();
  expect(f.said).toEqual(["routes-withhold-failed"]);
  expect(f.events.filter((e) => e.includes("begun"))).toHaveLength(2);

  delete f.hooks.withhold;
  await f.look();
  expect(f.said).toEqual(["routes-withhold-failed", "routes-withheld"]);
  expect(f.live).toEqual(new Set([API]));
  await f.guard.release();
});

test("the plan the route is published under decides who is behind a port, and another Target's publication changes nothing", async () => {
  const f = fixture();
  f.guard.watch(target());
  f.seen.set("web", { state: "stopped" });
  // Published with the ports swapped: API's port is web's now.
  f.guard.publishedUnder(target({ web: API, api: WEB }));
  await f.look();
  expect(f.events).toContain(`withhold ${API} begun`);

  f.events.length = 0;
  f.live.add(API);
  f.guard.publishedUnder({
    ...target(),
    id: "another",
  });
  await f.look();
  expect(f.events).toContain(`withhold ${API} begun`);
  await f.guard.release();
});

test("release joins the look in flight, drops its late answer, and no look follows", async () => {
  const f = fixture();
  f.guard.watch(target());
  let answerLate!: (seen: ProcessObservation) => void;
  f.seen.set(
    "web",
    new Promise<ProcessObservation>((resolve) => (answerLate = resolve)),
  );
  f.startLook();
  await settled();
  await f.guard.release();
  answerLate({ state: "stopped" });
  await settled();
  expect(f.events).toEqual(["read"]);
  expect(f.waiting.size).toBe(0);
  f.guard.watch(target());
  expect(f.waiting.size).toBe(0);
});

test("release waits for a withholding the look has begun", async () => {
  const f = fixture();
  f.guard.watch(target());
  f.seen.set("web", { state: "stopped" });
  const held = gate();
  f.hooks.withhold = () => {
    held.reach();
    return held.opened;
  };
  f.startLook();
  await held.reached;
  let released = false;
  const releasing = f.guard.release().then(() => (released = true));
  await settled();
  expect(released).toBe(false);
  held.open();
  await releasing;
  expect(f.events.at(-1)).toBe("withhold done");
});

test("boundedObservations: aborting its signal expires what has not settled, without the deadline or the provider", async () => {
  const controller = new AbortController();
  const never: ObservationDeadline = { schedule: () => () => {} };
  let seen: AbortSignal | undefined;
  const results = boundedObservations(
    [
      async () => "answered",
      (signal) => {
        seen = signal;
        return new Promise<string>(() => {});
      },
    ],
    2000,
    never,
    controller.signal,
  );
  await settled();
  controller.abort();
  expect(await results).toEqual([
    { kind: "completed", value: "answered" },
    { kind: "expired" },
  ]);
  expect(seen?.aborted).toBe(true);
});

test("boundedObservations: a signal aborted already starts no job", async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;
  const results = await boundedObservations(
    [
      async () => {
        started = true;
        return "answered";
      },
    ],
    2000,
    { schedule: () => () => {} },
    controller.signal,
  );
  expect(results).toEqual([{ kind: "expired" }]);
  await settled();
  expect(started).toBe(false);
});

/** A guard that records whether a change runs inside its section. */
function recordingGuard() {
  let depth = 0;
  const guard: RouteGuard = {
    watch() {},
    async exclusive(change) {
      depth++;
      try {
        return await change();
      } finally {
        depth--;
      }
    },
    publishedUnder() {
      published.push(depth ? "published inside" : "published outside");
    },
    async release() {},
  };
  const published: string[] = [];
  return { guard, inSection: () => depth > 0, published };
}

test("a lifecycle under a guard runs every route change and journal write inside its section, and only those", async () => {
  const { guard, inSection, published } = recordingGuard();
  const ran: string[] = [];
  const called = (name: string) => {
    ran.push(`${name} ${inSection() ? "inside" : "outside"}`);
  };
  const effects: TargetEffects = {
    pruneCheckpoints: async () => [],
    async checkpoint(record) {
      called("checkpoint");
      return {
        targetId: record.id,
        async commit() {
          called("commit");
        },
        async rollback() {
          called("rollback");
        },
      };
    },
    async restoreEffects() {
      called("restore");
    },
    async commitEffects() {
      called("commitEffects");
    },
    async retireSuperseded() {
      called("retire");
    },
    async retireArtifacts() {},
    supervisor: () =>
      ({
        async observe() {
          return { state: "stopped" };
        },
        async stop() {
          called("stop");
          return { outcome: "unchanged" };
        },
        async ensureRunning() {
          return { outcome: "unchanged" };
        },
      }) as never,
    async prepare() {},
    async environment() {
      return {};
    },
    async health() {
      return { ready: true };
    },
    async build() {},
    async install() {
      called("install");
      return { outcome: "unchanged" };
    },
    listeners: async () => ({ state: "observed", listeners: [] }),
    livePorts: async () => new Set<number>(),
    async route() {
      called("route");
    },
    async withhold() {
      called("withhold");
    },
    async removeRoute() {
      called("removeRoute");
    },
    withdrawRoute: async () => undefined,
    pruneRoutes: async () => [],
  };
  const lifecycle = withStops(createTargetLifecycle(effects), { guard });
  const record = target();
  const checkpoint = await lifecycle.checkpoint(record);
  await checkpoint.commit();
  await checkpoint.rollback();
  await lifecycle.restoreEffects(record);
  await lifecycle.commitEffects(record);
  await lifecycle.retireSuperseded(record, record);
  await lifecycle.withhold(record);
  await lifecycle.withholdPorts(record, new Set([WEB]));
  await lifecycle.down(record);
  await lifecycle.retire(record);
  await lifecycle.up({
    ...record,
    plan: {
      ...record.plan,
      domain: undefined,
      proxy: undefined,
      components: [{ kind: "installed", name: "tool" }],
    },
  } as unknown as TargetRecord);
  expect(ran.filter((line) => line.endsWith("outside"))).toEqual([
    // A process stop is no route change: looks go on through it.
    "stop outside",
    "stop outside",
    "stop outside",
    "stop outside",
  ]);
  for (const change of [
    "checkpoint",
    "commit",
    "rollback",
    "restore",
    "commitEffects",
    "retire",
    "withhold",
    "removeRoute",
    "install",
    "route",
  ])
    expect(ran).toContain(`${change} inside`);
  expect(new Set(published)).toEqual(new Set(["published inside"]));
});
