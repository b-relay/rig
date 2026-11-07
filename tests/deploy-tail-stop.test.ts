import { afterEach, expect, test } from "bun:test";
import type { RigError } from "../src/domain/errors";
import {
  API,
  LIVE,
  MOVED,
  NONE,
  WEB,
  fixture,
  gate,
  noTail,
  removeTailFixtures,
  settled,
} from "./support/deploy-tail-fixture";

/** The stop side and the guard of ADR 0020: see the fixture. */

afterEach(removeTailFixtures);

test("a deploy: with search's stop blocked every path stays live and no route changes, and they are withheld before web stops", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  expect(await f.paths()).toEqual(LIVE);
  expect(f.applied).toEqual([]);
  expect(f.stops).toEqual([]);

  search.open();
  await deploying;
  expect(f.stops).toEqual(["search", "web", "api"]);
  expect(f.pathsAtStop.get("search")).toEqual(LIVE);
  expect(f.pathsAtStop.get("web")).toEqual(NONE);
  expect(await f.paths()).toEqual(LIVE);
  // Melody's three publishes, as today: the stop's withhold, the start's, and the publish.
  expect(f.applied).toEqual([NONE, NONE, LIVE]);
  expect(f.overlaps).toEqual([]);
});

test("rig restart: with search's stop blocked every path stays live, and they are withheld before web stops", async () => {
  const f = await fixture();
  await f.deployedThenChanged([]);
  const search = f.holdStop("search");
  const restarting = f.restart();
  await search.reached;
  expect(await f.paths()).toEqual(LIVE);
  expect(f.stops).toEqual([]);

  search.open();
  await restarting;
  expect(f.pathsAtStop.get("search")).toEqual(LIVE);
  expect(f.pathsAtStop.get("web")).toEqual(NONE);
  expect(f.stops).toEqual(["search", "web", "api", "db"]);
  expect(await f.paths()).toEqual(LIVE);
  expect(f.overlaps).toEqual([]);
});

test("plain rig down withholds before its first stop, the tail's too, and nothing looks", async () => {
  const f = await fixture();
  await f.deployedThenChanged([]);
  await f.down();
  expect(f.stops).toEqual(["search", "web", "api", "db"]);
  expect(f.pathsAtStop.get("search")).toEqual(NONE);
  expect(f.looks.scheduled).toBe(0);
});

test("deploy --no-up withholds before its first stop, as nothing replaces what it stops, and nothing looks", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web"]);
  await f.deploy("c2", { noUp: true });
  expect(f.stops).toEqual(["search", "web", "api", "db"]);
  expect(f.pathsAtStop.get("search")).toEqual(NONE);
  expect(f.looks.scheduled).toBe(0);
});

test("destroying a Preview withholds before its first stop, and nothing looks", async () => {
  const f = await fixture();
  await f.command({
    action: "deploy",
    project: "shop",
    target: "preview",
    branch: "feature",
  });
  f.reset();
  const preview = (await f.command({
    action: "status",
    project: "shop",
  })) as { targets: { name: string; kind: string }[] };
  const name = preview.targets.find((t) => t.kind === "preview")!.name;
  await f.command({
    action: "destroy",
    project: "shop",
    target: "preview",
    deployment: name,
  });
  expect(f.stops).toEqual(["search", "web", "api", "db"]);
  expect(f.pathsAtStop.get("search")).toEqual(NONE);
  expect(f.looks.scheduled).toBe(0);
});

test("the rollback of a candidate that was published withholds before it stops the candidate's tail", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  f.failCommit();
  await expect(f.deploy("c2")).rejects.toThrow("was served from");
  // The previous plan's stop kept the tail first; the candidate's clean-up did not.
  expect(f.stops).toEqual(["search", "web", "search", "web"]);
  expect(f.pathsAtStop.get("search")).toEqual({ "/": "503", "/api": API });
  expect(await f.paths()).toEqual(LIVE);
  expect((await f.stable()).commit).toBe("c1");
  expect(f.overlaps).toEqual([]);
  expect(f.waiting.size).toBe(0);
});

test("rigd killed during the tail's stop leaves the old paths live, for the recovery duty to watch; rig down stops withheld", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const search = f.holdStop("search", { detach: true });
  const deploying = f.deploy("c2");
  await search.reached;
  search.open();
  await expect(deploying).rejects.toMatchObject({ code: "STOP_DETACHED" });
  expect(await f.paths()).toEqual(LIVE);
  expect((await f.stable()).recovery).toBeDefined();
  expect(f.waiting.size).toBe(0);

  f.reopen();
  await f.reconcile();
  await f.exit("web");
  await f.supervise();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });

  f.pathsAtStop.clear();
  f.holdStop("search").open();
  await f.down();
  expect((await f.stable()).recovery).toBeUndefined();
  // A recovery stop withholds every path before its first stop.
  expect(f.pathsAtStop.get("search")).toEqual(NONE);
});

test("a routed Service seen stopped during the tail's stop has its paths withheld by the next look, and only those; nothing starts", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  await f.exit("web");
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  expect(f.applied).toEqual([{ "/": "503", "/api": API }]);
  expect(f.said).toEqual([
    {
      outcome: "routes-withheld",
      evidence: expect.stringContaining("web stopped"),
    },
  ]);
  expect(f.starts).toEqual([]);

  // Seen once: the path is gone, so the next look asks only about what is still live.
  f.observed.length = 0;
  await f.look();
  expect(f.observed).toEqual(["api"]);

  search.open();
  await deploying;
  expect(await f.paths()).toEqual(LIVE);
  expect(f.overlaps).toEqual([]);
});

test("the guard reads a path by the plan it was published under: a port the new plan gives another Service still goes for the one behind it now", async () => {
  const f = await fixture();
  await f.deploy("c1");
  // The new plan swaps the two ports, so `web`'s port is the running `api`'s under it.
  f.config.services!.web!.ports = { http: API };
  f.config.services!.api!.ports = { http: WEB };
  f.config.services!.search!.command = "search2";
  f.listening.web = [API];
  f.listening.api = [WEB];
  f.reset();
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  await f.exit("web");
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  search.open();
  await deploying;
  expect(await f.paths()).toEqual({ "/": API, "/api": WEB });
});

test("once the new plan is published the guard reads a path by it: a Service that exits on its new port is withheld, and the deploy still commits", async () => {
  const f = await fixture();
  await f.deploy("c1");
  f.config.services!.web!.ports = { http: MOVED };
  f.config.services!.search!.command = "search2";
  f.listening.web = [MOVED];
  f.reset();
  const write = gate();
  f.failCommit({ hold: write });
  const deploying = f.deploy("c2");
  await write.reached;
  expect(await f.paths()).toEqual({ "/": MOVED, "/api": API });

  await f.exit("web");
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });

  // Before the commit is decided this only withholds: failing the start for it comes with publishing before the tail.
  write.open();
  await deploying;
  expect((await f.stable()).commit).toBe("c2");
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  expect(f.overlaps).toEqual([]);
});

test.each(["unknown", "rejected"] as const)(
  "a Service whose observation is %s keeps its path, and the next look that sees it stopped withholds it",
  async (kind) => {
    const f = await fixture();
    await f.deployedThenChanged(["api", "web", "search"]);
    const search = f.holdStop("search");
    const deploying = f.deploy("c2");
    await search.reached;
    await f.exit("web");
    f.answer.set("web", { kind });
    await f.look();
    expect(await f.paths()).toEqual(LIVE);
    expect(f.applied).toEqual([]);

    f.answer.delete("web");
    await f.look();
    expect(await f.paths()).toEqual({ "/": "503", "/api": API });
    search.open();
    await deploying;
  },
);

test("a look held in flight is joined before the stop's withhold, without waiting for the provider, and its late answer changes nothing", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  const web = f.holdObservation("web");
  // Fired by hand: it stays in flight, and no later one is scheduled meanwhile.
  const [fire] = f.waiting;
  f.waiting.delete(fire!);
  fire!();
  await web.reached;
  expect(f.waiting.size).toBe(0);

  // No budget ever ends here: only the stop's section can end the look.
  search.open();
  await deploying;
  expect(web.held.signal?.aborted).toBe(true);
  expect(f.applied).toEqual([NONE, NONE, LIVE]);

  // The new plan is published by now. The stale answer that says web stopped must not take its path.
  web.answerLate({ state: "stopped" });
  await settled();
  expect(await f.paths()).toEqual(LIVE);
  expect(f.applied).toEqual([NONE, NONE, LIVE]);
});

test("a look the stop's section ends still withholds a kept Service it already saw stopped, before the stop goes on", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const search = f.holdStop("search");
  const webStop = f.holdStop("web");
  const deploying = f.deploy("c2");
  await search.reached;
  await f.exit("api");
  const web = f.holdObservation("web");
  const [fire] = f.waiting;
  f.waiting.delete(fire!);
  fire!();
  await web.reached;
  await settled();

  search.open();
  await webStop.reached;
  expect(web.held.signal?.aborted).toBe(true);
  expect(await f.paths()).toEqual(NONE);

  webStop.open();
  web.answerLate({ state: "stopped" });
  f.answer.delete("web");
  await deploying;
  expect(f.overlaps).toEqual([]);
});

test("a withhold the guard has begun finishes through its journal capture before the stop's own route change starts", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  await f.exit("web");
  const apply = gate();
  f.proxy.hold = apply;
  const looking = f.look();
  await apply.reached;
  expect(f.applied).toEqual([{ "/": "503", "/api": API }]);

  search.open();
  await settled();
  // The stop has reached its withhold, and waits behind the guard's.
  expect(f.stops).toEqual(["search"]);
  expect(f.applied).toEqual([{ "/": "503", "/api": API }]);

  f.proxy.hold = undefined;
  apply.open();
  await looking;
  await deploying;
  expect(f.overlaps).toEqual([]);
  expect(f.applied).toEqual([{ "/": "503", "/api": API }, NONE, NONE, LIVE]);
  expect(await f.paths()).toEqual(LIVE);
});

test("a proxy that refuses the guard's withhold is tried again by the next look, and said once", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["api", "web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  await f.exit("web");
  f.proxy.refuses = true;
  await f.look();
  await f.look();
  expect(await f.paths()).toEqual(LIVE);
  expect(f.said).toEqual([
    expect.objectContaining({
      outcome: "routes-withhold-failed",
      errorCode: "ROUTE_WITHHOLD",
    }),
  ]);

  f.proxy.refuses = false;
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  search.open();
  await deploying;
});

test("one guard holds across a deploy's stop and start: a kept routed Service that exits during the start is withheld, and looks end with the Operation", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const search = f.holdStop("search");
  const start = f.holdStart("web");
  const deploying = f.deploy("c2");
  await search.reached;
  expect(f.waiting.size).toBe(1);
  search.open();
  await start.reached;
  // The stop withheld only what it stops: `api` is kept, and keeps its path.
  expect(f.pathsAtStop.get("web")).toEqual({ "/": "503", "/api": API });
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });
  expect(f.waiting.size).toBe(1);

  await f.exit("api");
  await f.look();
  expect(await f.paths()).toEqual(NONE);

  start.open();
  await deploying;
  // Restart policy takes over once the Target is released: the deploy carried on, and nothing published its dead path.
  expect(await f.paths()).toEqual({ "/": WEB, "/api": "503" });
  expect((await f.stable()).commit).toBe("c2");
  expect(f.looks.mostWaiting).toBe(1);
  expect(f.waiting.size).toBe(0);
  expect(f.overlaps).toEqual([]);
});

test("one guard holds across rig restart's stop and start, with nothing to observe once the paths are withheld, and ends with it", async () => {
  const f = await fixture();
  await f.deployedThenChanged([]);
  const search = f.holdStop("search");
  const start = f.holdStart("web");
  const restarting = f.restart();
  await search.reached;
  await f.exit("web");
  await f.look();
  expect(await f.paths()).toEqual({ "/": "503", "/api": API });

  search.open();
  await start.reached;
  expect(f.waiting.size).toBe(1);
  f.observed.length = 0;
  await f.look();
  expect(f.observed).toEqual([]);

  start.open();
  await restarting;
  expect(await f.paths()).toEqual(LIVE);
  expect(f.looks.mostWaiting).toBe(1);
  expect(f.waiting.size).toBe(0);
});

test("the guard's withhold is journalled as the transaction's own: the rollback that follows does not take it for an outside change", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const start = f.holdStart("web");
  f.failCommit();
  const deploying = f.deploy("c2");
  await start.reached;
  await f.exit("api");
  await f.look();
  expect(await f.paths()).toEqual(NONE);
  start.open();
  await expect(deploying).rejects.toThrow("was served from");
  // Not DEPLOY_ROLLBACK_BLOCKED: the previous plan is back, api started again by its own start.
  expect((await f.stable()).commit).toBe("c1");
  expect((await f.stable()).recovery).toBeUndefined();
  expect(f.starts).toContain("api");
  expect(await f.paths()).toEqual(LIVE);
  expect(f.overlaps).toEqual([]);
});

test("a deploy that restarts only the tail changes no path while it stops, as a kept routed Service keeps its own", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["search"]);
  await f.deploy("c2");
  expect(f.stops).toEqual(["search"]);
  expect(f.pathsAtStop.get("search")).toEqual(LIVE);
  for (const paths of f.applied) expect(paths).toEqual(LIVE);
});

test("a plan with no tail makes the same route calls in the same order, withheld before the first stop", async () => {
  const f = await fixture(noTail());
  await f.deployedThenChanged(["api", "web"]);
  await f.deploy("c2");
  expect(f.stops).toEqual(["web", "api"]);
  expect(f.pathsAtStop.get("web")).toEqual(NONE);
  expect(f.applied).toEqual([NONE, NONE, LIVE]);
  expect(f.overlaps).toEqual([]);
});

test("a withhold that fails after the tail stopped says no Service with a path stopped, and web keeps running", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const search = f.holdStop("search");
  const deploying = f.deploy("c2");
  await search.reached;
  f.proxy.refuses = true;
  search.open();
  const failure = (await deploying.catch(
    (error: unknown) => error,
  )) as RigError;
  expect(failure.code).toBe("DEPLOY_ROLLBACK_BLOCKED");
  expect(f.stops).toEqual(["search"]);
  expect(await f.paths()).toEqual(LIVE);
  expect(f.waiting.size).toBe(0);
});

test("a Target no Operation holds is never looked at: a status and a supervision pass schedule no look", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web"]);
  await f.command({ action: "status", project: "shop" });
  await f.supervise();
  expect(f.looks.scheduled).toBe(0);
  expect(f.waiting.size).toBe(0);
});
