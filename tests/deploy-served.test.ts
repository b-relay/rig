import { afterEach, expect, test } from "bun:test";
import type { RigError } from "../src/domain/errors";
import { FileStateStore } from "../src/runtime/state-store";
import {
  fixture,
  gate,
  removeTailFixtures,
} from "./support/deploy-tail-fixture";

/** What a deploy says its candidate served (ADR 0020): `recovery.served` while it runs, `servedAt` in its history, and its
 * error and Activity when it failed after serving, also when only `rig down` is left to say it, after rigd died. */

afterEach(removeTailFixtures);

const FROM = "2026-11-05T08:00:00.000Z";

/** The deploy's entries, by the outcome `rig activity` and the history show. */
async function receipts(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.store.read();
  return {
    history: (state.deployments ?? []).filter((entry) => entry.commit === "c2"),
    activity: state.activity.filter(
      (entry) => entry.action === "deploy" && entry.outcome !== "deployed",
    ),
    served: state.targets.find((t) => t.kind === "stable")?.recovery?.served,
  };
}
const minutes = (f: Awaited<ReturnType<typeof fixture>>, count: number) => {
  f.clock.ms += count * 60_000;
};

test("a failed deploy that served says from when and for how long, in its error, Activity and history", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const write = gate();
  f.failCommit({ hold: write, fails: true });
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await write.reached;
  // Durable while it serves, before anything else is decided.
  expect((await receipts(f)).served).toEqual({ from: FROM });
  minutes(f, 2);
  write.open();
  const failure = (await deploying) as RigError;

  const said = `new Commit c2 was served from ${FROM} for 2m00s`;
  expect(failure.message).toContain(`The ${said}.`);
  const { history, activity } = await receipts(f);
  expect(history).toEqual([
    expect.objectContaining({ outcome: "failed", servedAt: FROM }),
  ]);
  expect(activity).toEqual([
    expect.objectContaining({
      outcome: "failed",
      message: `${said}: ${failure.code}`,
    }),
  ]);
  expect((await f.stable()).commit).toBe("c1");
});

test("a failed deploy that never published says nothing of serving, and neither does its history", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const web = f.holdHealth("web");
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await web.reached;
  await f.exit("web");
  web.open();
  const failure = (await deploying) as RigError;
  expect(failure.code).toBe("PROCESS_EXITED");
  expect(failure.message).not.toContain("served");
  const { history, activity } = await receipts(f);
  expect(history).toEqual([expect.objectContaining({ outcome: "failed" })]);
  expect(history[0]!.servedAt).toBeUndefined();
  expect(activity[0]!.message).toBe("PROCESS_EXITED");
});

test("a successful deploy records when it began to serve, and its Activity says nothing more", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  await f.deploy("c2");
  const state = await f.store.read();
  expect(state.deployments!.at(-1)).toMatchObject({
    outcome: "deployed",
    servedAt: FROM,
  });
  expect(state.activity.at(-1)!.message).not.toContain("served");
  expect((await f.stable()).recovery).toBeUndefined();
});

test("a publish that reaches only kept Services records nothing: no new code is behind it", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["search"]);
  const write = gate();
  f.failCommit({ hold: write, fails: true });
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await write.reached;
  expect((await receipts(f)).served).toBeUndefined();
  write.open();
  const failure = (await deploying) as Error;
  expect(failure.message).not.toContain("served");
  expect((await receipts(f)).history[0]!.servedAt).toBeUndefined();
});

test("the rollback's publication is not the new Commit's: what it served ends when its paths go, not when the previous version is back", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const write = gate();
  f.failCommit({ hold: write, fails: true });
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await write.reached;
  minutes(f, 2);
  // The rollback withholds the candidate's paths, then takes its time stopping and starting the previous version.
  const stop = f.holdStop("web");
  write.open();
  await stop.reached;
  expect((await receipts(f)).served).toEqual({
    from: FROM,
    until: "2026-11-05T08:02:00.000Z",
  });
  minutes(f, 5);
  stop.open();
  const failure = (await deploying) as RigError;
  expect(failure.message).toContain(`was served from ${FROM} for 2m00s.`);
  expect((await receipts(f)).history[0]!.servedAt).toBe(FROM);
  expect((await f.stable()).commit).toBe("c1");
});

test("rigd killed before the router confirmed the publish: rig down says the new Commit may have served, at a time not recorded", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  // The next route change after web's start is the publish.
  const start = f.holdStart("web");
  const deploying = f.deploy("c2");
  void deploying.catch(() => {});
  await start.reached;
  const apply = gate();
  f.proxy.hold = apply;
  start.open();
  await apply.reached;
  f.proxy.hold = undefined;
  expect((await receipts(f)).served).toEqual({});

  f.reopen();
  await f.reconcile();
  minutes(f, 3);
  await f.down();
  const { history, activity, served } = await receipts(f);
  expect(served).toBeUndefined();
  expect(history).toEqual([
    expect.objectContaining({
      outcome: "failed",
      branch: "main",
      previousCommit: "c1",
    }),
  ]);
  expect(history[0]!.servedAt).toBeUndefined();
  expect(activity).toEqual([
    expect.objectContaining({
      outcome: "failed",
      message:
        "new Commit c2 may have been served, from a time Rig did not record; rigd stopped before the deploy finished, and rig down stopped it",
    }),
  ]);
});

test("rigd killed while the new Commit served: rig down says it served at most until its own withhold", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const write = gate();
  f.failCommit({ hold: write, fails: true });
  void f.deploy("c2").catch(() => {});
  await write.reached;

  f.reopen();
  await f.reconcile();
  minutes(f, 3);
  await f.down();
  const { history, activity } = await receipts(f);
  expect(history).toEqual([
    expect.objectContaining({ outcome: "failed", servedAt: FROM }),
  ]);
  expect(activity[0]!.message).toStartWith(
    `new Commit c2 was served from ${FROM} for at most 3m00s;`,
  );
});

test("rigd killed after the rollback withdrew the new Commit's paths: rig down says how long it served", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const write = gate();
  f.failCommit({ hold: write, fails: true });
  void f.deploy("c2").catch(() => {});
  await write.reached;
  minutes(f, 2);
  const stop = f.holdStop("search");
  write.open();
  await stop.reached;
  f.releaseStop("search");

  f.reopen();
  await f.reconcile();
  minutes(f, 10);
  await f.down();
  const { history, activity } = await receipts(f);
  expect(history).toEqual([
    expect.objectContaining({ outcome: "failed", servedAt: FROM }),
  ]);
  expect(activity[0]!.message).toStartWith(
    `new Commit c2 was served from ${FROM} for 2m00s;`,
  );
});

test("rigd killed once the commit was decided: rig down records a completed deploy, served from when it was published", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  // Held on its way to the store, after the decision was written: the write that drops `recovery`.
  const write = gate();
  f.failWrite(
    (state) =>
      state.targets.some((t) => t.kind === "stable" && !t.recovery) &&
      state.targets.some((t) => t.commit === "c2"),
    { hold: write },
  );
  void f.deploy("c2").catch(() => {});
  await write.reached;
  expect((await f.stable()).recovery?.stage).toBe("committing");

  f.reopen();
  await f.reconcile();
  minutes(f, 3);
  await f.down();
  const state = await f.store.read();
  expect(state.deployments!.at(-1)).toMatchObject({
    commit: "c2",
    outcome: "deployed",
    servedAt: FROM,
  });
  expect(
    state.activity.filter((entry) => entry.action === "deploy").at(-1),
  ).toMatchObject({
    outcome: "deployed",
    message: `new Commit c2 was served from ${FROM}; rigd stopped before the deploy finished, and rig down finished its commit`,
  });
});

test("a settling write that fails leaves the recovery and no entry, and the rig down that retries adds exactly one", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const write = gate();
  f.failCommit({ hold: write, fails: true });
  void f.deploy("c2").catch(() => {});
  await write.reached;
  f.reopen();
  await f.reconcile();
  f.failWrite((state) =>
    state.targets.some((t) => t.kind === "stable" && !t.recovery),
  );
  await expect(f.down()).rejects.toThrow("the disk is full");
  expect((await receipts(f)).served).toEqual({ from: FROM });
  expect((await receipts(f)).history).toEqual([]);

  await f.down();
  await f.down();
  const { history, activity, served } = await receipts(f);
  expect(served).toBeUndefined();
  expect(history).toHaveLength(1);
  expect(
    activity.filter((entry) => entry.message?.includes("served")),
  ).toHaveLength(1);
});

test("a deploy that failed and recorded itself is not recorded again by the rig down that settles its recovery", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  // The rollback cannot withhold the candidate's paths: the deploy is blocked, with its recovery left for rig down.
  const write = gate();
  f.failCommit({ hold: write, fails: true });
  const deploying = f.deploy("c2").catch((error: unknown) => error);
  await write.reached;
  f.proxy.refuses = true;
  write.open();
  expect(((await deploying) as RigError).code).toBe("DEPLOY_ROLLBACK_BLOCKED");
  expect((await receipts(f)).history).toHaveLength(1);

  f.proxy.refuses = false;
  await f.down();
  expect((await receipts(f)).history).toHaveLength(1);
});

test("a state file holding what a candidate served reads as written on this version", async () => {
  const f = await fixture();
  await f.deployedThenChanged(["web", "search"]);
  const write = gate();
  f.failCommit({ hold: write, fails: true });
  void f.deploy("c2").catch(() => {});
  await write.reached;
  const fresh = new FileStateStore(f.root);
  const recovery = (await fresh.read()).targets.find(
    (t) => t.kind === "stable",
  )!.recovery!;
  expect(recovery.served).toEqual({ from: FROM });
  expect(recovery.stage).toBe("pending");
});
