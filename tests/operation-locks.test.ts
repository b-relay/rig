import { expect, test } from "bun:test";
import {
  HOST_SCOPE,
  createOperationLocks,
  projectScope,
  projectTargetsScope,
  registrationScope,
  scopesConflict,
  targetScope,
} from "../src/runtime/operation-locks";

const working = targetScope("p1", { kind: "working", name: "working" });
const stable = targetScope("p1", { kind: "stable", name: "stable" });
const other = targetScope("p2", { kind: "working", name: "working" });
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("scopes conflict along the Host, Project and Target hierarchy only", () => {
  expect(scopesConflict([working], [working])).toBe(true);
  expect(scopesConflict([working], [stable])).toBe(false);
  expect(scopesConflict([working], [other])).toBe(false);
  expect(scopesConflict([projectScope("p1")], [stable])).toBe(true);
  expect(scopesConflict([projectScope("p1")], [other])).toBe(false);
  expect(scopesConflict([HOST_SCOPE], [other])).toBe(true);
  expect(scopesConflict([registrationScope("a")], [projectScope("a")])).toBe(
    false,
  );
  // A Target is keyed by role, so a name recorded before names were fixed does not change the key.
  expect(targetScope("p1", { kind: "working", name: "renamed" })).toEqual(
    working,
  );
  expect(
    scopesConflict(
      [targetScope("p1", { kind: "preview", name: "a" })],
      [targetScope("p1", { kind: "preview", name: "b" })],
    ),
  ).toBe(false);
});

test("requests on different Targets are granted together; one on the same Target waits for the release", async () => {
  const locks = createOperationLocks();
  const a = await locks.acquire("a", [working]);
  const b = await locks.acquire("b", [stable]);
  const c = await locks.acquire("c", [other]);
  let granted = false;
  const waiting = locks.acquire("d", [working]).then((lease) => {
    granted = true;
    return lease;
  });
  await settled();
  expect(granted).toBe(false);
  expect(locks.position("d")).toEqual({ holders: ["a"], queued: [] });
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
  const stop = await locks.acquire("stop", [working]);
  const order: string[] = [];
  const project = locks.acquire("rename", [projectScope("p1")]).then((l) => {
    order.push("rename");
    return l;
  });
  const later = locks.acquire("up-stable", [stable]).then((l) => {
    order.push("up-stable");
    return l;
  });
  // Another Project is unaffected by the queue.
  const unrelated = await locks.acquire("other", [other]);
  expect(locks.tryAcquire("probe", [stable])).toBeUndefined();
  expect(locks.position("up-stable")).toEqual({
    holders: [],
    queued: ["rename"],
  });
  expect(locks.busy(projectTargetsScope("p1"))).toBe(true);
  expect(locks.busy(projectTargetsScope("p3"))).toBe(false);
  stop.release();
  (await project).release();
  (await later).release();
  unrelated.release();
  expect(order).toEqual(["rename", "up-stable"]);
});

test("tryAcquire takes only what is free now and queues nothing", () => {
  const locks = createOperationLocks();
  const held = locks.tryAcquire("a", [working])!;
  expect(held).toBeDefined();
  expect(locks.tryAcquire("b", [working])).toBeUndefined();
  expect(locks.waiting()).toBe(0);
  expect(locks.tryAcquire("c", [other])).toBeDefined();
});

test("a Host lease splits into Target leases before anything queued behind it runs", async () => {
  const locks = createOperationLocks();
  const host = await locks.acquire("reconcile", [HOST_SCOPE]);
  let granted = false;
  const queued = locks.acquire("up", [working]).then((lease) => {
    granted = true;
    return lease;
  });
  const [first, second] = host.split([
    { id: "reconcile:working", scopes: [working] },
    { id: "reconcile:other", scopes: [other] },
  ]);
  await settled();
  expect(granted).toBe(false);
  second!.release();
  first!.release();
  (await queued).release();
  expect(() => host.split([])).toThrow();
  expect(() =>
    locks.tryAcquire("x", [working])!.split([{ id: "y", scopes: [stable] }]),
  ).toThrow();
});

test("idle waits for every holder and waiter", async () => {
  const locks = createOperationLocks();
  const a = await locks.acquire("a", [working]);
  const b = locks.acquire("b", [working]);
  let idle = false;
  const done = locks.idle().then(() => (idle = true));
  a.release();
  await settled();
  expect(idle).toBe(false);
  (await b).release();
  await done;
  expect(idle).toBe(true);
});
