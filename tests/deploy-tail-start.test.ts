import { afterEach, expect, test } from "bun:test";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type { RigError } from "../src/domain/errors";
import {
  API,
  LIVE,
  NONE,
  WEB,
  fixture,
  gate,
  removeTailFixtures,
} from "./support/deploy-tail-fixture";

/** The start side of ADR 0020: every path is published before the Services at the end of the plan that no path needs
 * start, the guard watches through them, the final checks and the clean-up, and a Service the start started that stops
 * before the commit is decided fails it. Through the real runtime, lifecycle and effects over the tail fixture. */

afterEach(removeTailFixtures);

const DB = 47504,
  SEARCH = 47505;
const FROM = "2026-11-05T08:00:00.000Z";
const LIVE_ROUTE = `route /=${WEB} /api=${API}`;
const NO_ROUTE = "route /=503 /api=503";

/** Melody's shape with a start check on `db` and on `search`, so the test can hold one: each has a port and no path. */
function checked(extra: Record<string, unknown> = {}): ProjectConfig {
  return parseProjectConfig({
    name: "shop",
    domain: "shop.test",
    proxy: {
      "/": "${services.web.ports.http}",
      "/api": "${services.api.ports.http}",
    },
    services: {
      db: { command: "db", ports: { pg: DB } },
      api: { command: "api", ports: { http: API }, depends_on: ["db"] },
      web: { command: "web", ports: { http: WEB } },
      search: { command: "search", ports: { http: SEARCH } },
    },
    targets: { stable: { domain: "shop.test" } },
    ...extra,
  });
}
async function checkedFixture(extra?: Record<string, unknown>) {
  const f = await fixture(checked(extra));
  f.listening.db = [DB];
  f.listening.search = [SEARCH];
  return f;
}
/** Fires the look waiting and leaves it to run. */
function fire(f: Awaited<ReturnType<typeof fixture>>) {
  const [next] = f.waiting;
  if (!next) throw new Error("no look is waiting");
  f.waiting.delete(next);
  next();
}
const minutes = (f: Awaited<ReturnType<typeof fixture>>, count: number) => {
  f.clock.ms += count * 60_000;
};

test("a deploy publishes every path before the tail starts: / and /api answer while search's start check is pending", async () => {
  const f = await checkedFixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdHealth("search");
  const deploying = f.deploy("c2");
  await search.reached;
  expect(await f.paths()).toEqual(LIVE);
  // Melody's three publishes, as before: the stop's withhold, the start's, and the publish.
  expect(f.applied).toEqual([NONE, NONE, LIVE]);
  // The deploy is still in progress: it commits only once search is verified.
  expect((await f.stable()).recovery?.stage).toBe("pending");
  expect(f.waiting.size).toBe(1);

  search.open();
  await deploying;
  expect(f.applied).toEqual([NONE, NONE, LIVE]);
  expect((await f.stable()).commit).toBe("c2");
  expect((await f.store.read()).deployments!.at(-1)!.servedAt).toBe(FROM);
  expect(f.overlaps).toEqual([]);
});

test("a first deploy and rig restart publish before their tail too, each watched from its start", async () => {
  const f = await checkedFixture();
  const first = f.holdHealth("search");
  const deploying = f.deploy("c1");
  await first.reached;
  expect(await f.paths()).toEqual(LIVE);
  expect(f.waiting.size).toBe(1);
  first.open();
  await deploying;

  const again = f.holdHealth("search");
  const restarting = f.restart();
  await again.reached;
  expect(await f.paths()).toEqual(LIVE);
  again.open();
  await restarting;
  expect(f.waiting.size).toBe(0);
});

test("a lone rig up watches what it published: a Service it started that exits during its tail's start check is withheld, cancels the check and fails the start", async () => {
  const f = await checkedFixture();
  await f.deploy("c1");
  await f.down();
  f.reset();
  const search = f.holdHealth("search");
  const starting = f
    .command({ action: "up", project: "shop", target: "stable" })
    .catch((error: unknown) => error);
  await search.reached;
  expect(await f.paths()).toEqual(LIVE);
  expect(f.waiting.size).toBe(1);

  await f.exit("web");
  fire(f);
  const failure = (await starting) as RigError;
  expect(failure).toMatchObject({
    code: "PROCESS_EXITED",
    details: { component: "web", exitCode: 1 },
  });
  // It served, so the hint no longer says that nothing was published.
  expect(failure.hint).not.toContain("published");
  expect(search.signal?.aborted).toBe(true);
  expect(f.said).toContainEqual({
    outcome: "routes-withheld",
    evidence: expect.stringContaining("web stopped"),
  });
  // Nothing to restore: what it started is stopped, and its paths withheld.
  expect(await f.paths()).toEqual(NONE);
  expect(f.stops).toEqual(expect.arrayContaining(["search", "api", "db"]));
  expect(f.waiting.size).toBe(0);
  search.open();
});

test("a tail failure after publication withholds what the deploy started at once, stops it, and restores the previous plan, whose start publishes before its own tail", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  f.exitsOnStart.add("search");
  const failure = (await f
    .deploy("c2")
    .catch((error: unknown) => error)) as RigError;
  expect(failure).toMatchObject({
    code: "PROCESS_EXITED",
    details: { component: "search" },
  });
  expect(failure.message).toContain(
    `The new Commit c2 was served from ${FROM} for 0s.`,
  );
  const searched = f.timeline.indexOf("start search");
  // Published before the tail, withheld the moment it failed.
  expect(f.timeline.slice(searched - 1, searched + 2)).toEqual([
    LIVE_ROUTE,
    "start search",
    NO_ROUTE,
  ]);
  // The previous plan's start: its paths go live before its own search starts.
  expect(f.timeline.slice(-2)).toEqual([LIVE_ROUTE, "start search"]);
  expect((await f.stable()).commit).toBe("c1");
  expect(await f.paths()).toEqual(LIVE);
  expect(f.overlaps).toEqual([]);
  expect(f.waiting.size).toBe(0);
});

test("a routed exit during the final checks, with db's final check pending, is withheld at the next look, cancels that check and fails the deploy, which rolls back", async () => {
  const f = await checkedFixture();
  await f.deployedThenChanged(["db", "web", "search"]);
  const search = f.holdHealth("search");
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await search.reached;
  // db's next check is its last: the final checks, once search passed.
  const db = f.holdHealth("db");
  search.open();
  await db.reached;
  await f.exit("web");
  fire(f);
  const failure = (await deploying) as RigError;
  expect(failure).toMatchObject({
    code: "PROCESS_EXITED",
    details: { component: "web" },
  });
  expect(failure.hint).not.toContain("published");
  // The provider never answered: the failure ended the check, as a deadline would.
  expect(db.signal?.aborted).toBe(true);
  expect((await f.stable()).commit).toBe("c1");
  expect(await f.paths()).toEqual(LIVE);
  db.open();
  expect(f.overlaps).toEqual([]);
});

test("a final observation that never answers does not hold off the rollback a routed exit starts", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["db", "web", "search"]);
  const spawn = f.holdStart("search");
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await spawn.reached;
  // From here db is observed four times by its final start check, then once more as the start's last look at it.
  const last = f.holdObserve("db", 4);
  spawn.open();
  await last.reached;
  await f.exit("web");
  fire(f);
  // The observation is still unanswered: the failure ends the wait, and the rollback completes.
  expect(await deploying).toMatchObject({
    code: "PROCESS_EXITED",
    details: { component: "web" },
  });
  expect((await f.stable()).commit).toBe("c1");
  expect((await f.stable()).recovery).toBeUndefined();
  expect(await f.paths()).toEqual(LIVE);
  last.open();
});

test("a kept routed Service that exits during the clean-up's long stop is withheld by the guard", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const spawn = f.holdStart("search");
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await spawn.reached;
  f.exitsOnStart.add("search");
  // The clean-up stops what the start started, web last.
  const stop = f.holdStop("web");
  spawn.open();
  await stop.reached;
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });

  await f.exit("api");
  await f.look();
  expect(await f.paths()).toEqual(NONE);
  stop.open();
  expect(await deploying).toMatchObject({ code: "PROCESS_EXITED" });
  // The rollback starts api again from the previous plan, as one that ended.
  expect((await f.stable()).commit).toBe("c1");
  expect(await f.paths()).toEqual(LIVE);
});

test("with api kept, the guard's withdrawal of web's path during search's pending spawn ends what c2 served; the spawn settles into the start's own and is stopped", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const spawn = f.holdStart("search");
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await spawn.reached;
  minutes(f, 2);
  await f.exit("web");
  await f.look();
  // api's path is the kept api's: it stays, and serves nothing of c2.
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  const until = "2026-11-05T08:02:00.000Z";
  expect((await f.stable()).recovery?.served).toEqual({ from: FROM, until });

  minutes(f, 5);
  spawn.open();
  const failure = (await deploying) as RigError;
  expect(failure).toMatchObject({
    code: "PROCESS_EXITED",
    details: { component: "web" },
  });
  // The clean-up's own withhold came later: the first end stands.
  expect(failure.message).toContain(`was served from ${FROM} for 2m00s.`);
  // search's spawn was in flight: it was recorded, then stopped with the rest.
  expect(f.stops.filter((name) => name === "search")).toHaveLength(2);
  expect((await f.stable()).commit).toBe("c1");
  expect(await f.paths()).toEqual(LIVE);
});

test("a failure latched after the start returned, just before the commit's section, rolls the deploy back with no committing written", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const decision = gate();
  let decided = false;
  void decision.reached.then(() => (decided = true));
  f.failCommit({ hold: decision });
  const returned = gate();
  f.afterUp.hold = returned;
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await returned.reached;
  await f.exit("web");
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });

  returned.open();
  expect(await deploying).toMatchObject({
    code: "PROCESS_EXITED",
    details: { component: "web" },
  });
  expect(decided).toBe(false);
  expect((await f.stable()).commit).toBe("c1");
  expect((await f.stable()).recovery).toBeUndefined();
  expect(await f.paths()).toEqual(LIVE);
});

test("an exit during the write that decides the commit is judged after it: the decided deploy stays deployed, and the exit only withholds", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const decision = gate();
  f.failCommit({ hold: decision });
  const deploying = f.deploy("c2");
  await decision.reached;
  // No look runs while the decision is written.
  expect(f.waiting.size).toBe(0);
  await f.exit("web");
  const completing = gate();
  f.failWrite(
    (state) => state.targets.some((t) => t.commit === "c2" && !t.recovery),
    { hold: completing },
  );
  decision.open();
  await completing.reached;
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });

  completing.open();
  await deploying;
  expect((await f.stable()).commit).toBe("c2");
  expect((await f.stable()).recovery).toBeUndefined();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
});

test("a Service whose state is unknown during the tail fails nothing, and keeps its path", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const spawn = f.holdStart("search");
  const deploying = f.deploy("c2");
  await spawn.reached;
  f.answer.set("web", { kind: "unknown" });
  await f.look();
  expect(await f.paths()).toEqual(LIVE);
  f.answer.delete("web");
  spawn.open();
  await deploying;
  expect((await f.stable()).commit).toBe("c2");
  expect(await f.paths()).toEqual(LIVE);
});

test("a publish the proxy refuses fails the start before the tail starts", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const web = f.holdStart("web");
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await web.reached;
  // The next change is the publish.
  f.proxy.refusals = 1;
  web.open();
  await deploying;
  // The candidate started api and web, and never search; the rollback then started all three.
  expect(f.starts).toEqual(["api", "web", "api", "web", "search"]);
  expect((await f.stable()).commit).toBe("c1");
  expect(await f.paths()).toEqual(LIVE);
});

test("a Tool that cannot be published fails the start before anything is published or the tail starts", async () => {
  const f = await fixture(
    parseProjectConfig({
      name: "shop",
      domain: "shop.test",
      proxy: {
        "/": "${services.web.ports.http}",
        "/api": "${services.api.ports.http}",
      },
      services: {
        db: { command: "db" },
        api: { command: "api", ports: { http: API }, depends_on: ["db"] },
        web: { command: "web", ports: { http: WEB } },
        search: { command: "search" },
      },
      tools: { cli: { bin: "bin/cli" } },
      targets: { stable: { domain: "shop.test" } },
    }),
  );
  await f.deployedThenChanged(["web", "search"]);
  f.tools.fails = new Error("the bin directory is read-only");
  await expect(f.deploy("c2")).rejects.toThrow(
    "the bin directory is read-only",
  );
  const before = f.timeline.slice(0, f.timeline.indexOf("install cli"));
  expect(before).toContain("start web");
  expect(before).not.toContain("start search");
  expect(before).not.toContain(LIVE_ROUTE);

  expect((await f.stable()).commit).toBe("c1");
});

test("after a Mac restart the start publishes before its tail, and a tail that fails is recorded failed with those paths withheld", async () => {
  const f = await fixture();
  await f.deploy("c1");
  f.reset();
  // Every process went with the Mac; the proxy comes back with the route as it was.
  f.processes.clear();
  f.host.session = {
    boot: "BOOT-2",
    bootedAt: "2026-11-05T09:00:00.000Z",
    login: "100003",
  };
  f.exitsOnStart.add("search");
  f.reopen();
  await f.reconcile();
  const searched = f.timeline.indexOf("start search");
  expect(f.timeline.slice(searched - 1, searched + 2)).toEqual([
    LIVE_ROUTE,
    "start search",
    NO_ROUTE,
  ]);
  expect(await f.paths()).toEqual(NONE);
  const state = await f.store.read();
  expect(state.activity.at(-1)).toMatchObject({
    action: "up",
    outcome: "failed",
    message: expect.stringContaining("PROCESS_EXITED"),
  });
  expect(f.waiting.size).toBe(0);
});
