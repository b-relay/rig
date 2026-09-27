import { expect, test } from "bun:test";
import {
  HOST_SCOPE,
  createOperationLocks,
  projectScope,
  registrationScope,
  scopesConflict,
  targetScope,
} from "../src/runtime/operation-locks";

const local = targetScope("p1", { kind: "local", name: "dev" });
const live = targetScope("p1", { kind: "live", name: "prod" });
const other = targetScope("p2", { kind: "local", name: "dev" });
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("scopes conflict along the Host, Project and Target hierarchy only", () => {
  expect(scopesConflict([local], [local])).toBe(true);
  expect(scopesConflict([local], [live])).toBe(false);
  expect(scopesConflict([local], [other])).toBe(false);
  expect(scopesConflict([projectScope("p1")], [live])).toBe(true);
  expect(scopesConflict([projectScope("p1")], [other])).toBe(false);
  expect(scopesConflict([HOST_SCOPE], [other])).toBe(true);
  expect(scopesConflict([registrationScope("a")], [projectScope("a")])).toBe(
    false,
  );
  // A Target is keyed by role, so its configured name does not change the key.
  expect(targetScope("p1", { kind: "local", name: "renamed" })).toEqual(local);
  expect(
    scopesConflict(
      [targetScope("p1", { kind: "preview", name: "a" })],
      [targetScope("p1", { kind: "preview", name: "b" })],
    ),
  ).toBe(false);
});

test("requests on different Targets are granted together; one on the same Target waits for the release", async () => {
  const locks = createOperationLocks();
  const a = await locks.acquire("a", [local]);
  const b = await locks.acquire("b", [live]);
  const c = await locks.acquire("c", [other]);
  let granted = false;
  const waiting = locks.acquire("d", [local]).then((lease) => {
    granted = true;
    return lease;
  });
  await settled();
  expect(granted).toBe(false);
  expect(locks.position("d")).toEqual({ holders: ["a"], ahead: 0 });
  expect(locks.holders()).toEqual(["a", "b", "c"]);
  a.release();
  a.release();
  const d = await waiting;
  expect(locks.position("d")).toBeUndefined();
  for (const lease of [b, c, d]) lease.release();
  await locks.idle();
  expect(locks.holders()).toEqual([]);
});

test("a waiting Project request is not overtaken by later Target requests of that Project", async () => {
  const locks = createOperationLocks();
  const stop = await locks.acquire("stop", [local]);
  const order: string[] = [];
  const project = locks.acquire("rename", [projectScope("p1")]).then((l) => {
    order.push("rename");
    return l;
  });
  const later = locks.acquire("up-live", [live]).then((l) => {
    order.push("up-live");
    return l;
  });
  // Another Project is unaffected by the queue.
  const unrelated = await locks.acquire("other", [other]);
  expect(locks.tryAcquire("probe", [live])).toBeUndefined();
  expect(locks.position("up-live")).toEqual({ holders: [], ahead: 1 });
  stop.release();
  (await project).release();
  (await later).release();
  unrelated.release();
  expect(order).toEqual(["rename", "up-live"]);
});

test("tryAcquire takes only what is free now and queues nothing", () => {
  const locks = createOperationLocks();
  const held = locks.tryAcquire("a", [local])!;
  expect(held).toBeDefined();
  expect(locks.tryAcquire("b", [local])).toBeUndefined();
  expect(locks.waiting()).toBe(0);
  expect(locks.tryAcquire("c", [other])).toBeDefined();
});

test("a Host lease splits into Target leases before anything queued behind it runs", async () => {
  const locks = createOperationLocks();
  const host = await locks.acquire("reconcile", [HOST_SCOPE]);
  let granted = false;
  const queued = locks.acquire("up", [local]).then((lease) => {
    granted = true;
    return lease;
  });
  const [first, second] = host.split([
    { id: "reconcile:local", scopes: [local] },
    { id: "reconcile:other", scopes: [other] },
  ]);
  await settled();
  expect(granted).toBe(false);
  second!.release();
  first!.release();
  (await queued).release();
  expect(() => host.split([])).toThrow();
  expect(() =>
    locks.tryAcquire("x", [local])!.split([{ id: "y", scopes: [live] }]),
  ).toThrow();
});

test("idle waits for every holder and waiter", async () => {
  const locks = createOperationLocks();
  const a = await locks.acquire("a", [local]);
  const b = locks.acquire("b", [local]);
  let idle = false;
  const done = locks.idle().then(() => (idle = true));
  a.release();
  await settled();
  expect(idle).toBe(false);
  (await b).release();
  await done;
  expect(idle).toBe(true);
});
