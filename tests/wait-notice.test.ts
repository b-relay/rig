import { expect, test } from "bun:test";
import { waitNotice, waitStatus } from "../src/cli/wait-notice";
import { createHostReservations } from "../src/runtime/host-reservations";

const view = {
  operationId: "op-1",
  action: "down",
  project: "fletcher",
  target: "local",
  phase: "stopping",
  startedAt: "2026-09-27T04:00:00.000Z",
};
const waitingOn = (
  holders: object[],
  ahead = 0,
): { operation: { state: "waiting"; waitingOn: object[]; ahead: number } } => ({
  operation: { state: "waiting", waitingOn: holders, ahead },
});

test("the wait line names the Target, what is happening to it, and how many more are ahead", () => {
  expect(waitNotice(waitingOn([view]))).toBe(
    "Waiting: fletcher local is stopping (operation op-1, started 2026-09-27T04:00:00.000Z).",
  );
  expect(
    waitNotice(
      waitingOn([{ ...view, target: undefined, phase: "renaming" }, view], 2),
    ),
  ).toBe(
    "Waiting: fletcher is being renamed (operation op-1, started 2026-09-27T04:00:00.000Z); 3 more ahead of this command.",
  );
  expect(
    waitNotice(
      waitingOn([
        {
          ...view,
          project: undefined,
          target: undefined,
          action: "prepare-uninstall",
          phase: "preparing to uninstall",
        },
      ]),
    ),
  ).toStartWith("Waiting: rigd is preparing to uninstall (operation op-1");
  // A phase this rig does not know yet still reads as the action.
  expect(waitNotice(waitingOn([{ ...view, phase: "draining" }]))).toStartWith(
    "Waiting: fletcher local is running down (",
  );
  expect(waitNotice(waitingOn([], 1))).toBe(
    "Waiting: 1 operation ahead of this command.",
  );
});

test("only a waiting Operation has a line; a running one and an unreadable reply do not", () => {
  expect(
    waitStatus({ operation: { state: "running", phase: "starting" } }),
  ).toEqual({ state: "running" });
  expect(waitStatus({ operation: { state: "unknown" } })).toBeUndefined();
  expect(waitStatus({ running: view, waiting: 1 })).toBeUndefined();
  expect(waitStatus("nonsense")).toBeUndefined();
  expect(waitStatus(waitingOn([view]))).toMatchObject({ state: "waiting" });
});

test("port claims are made one at a time, visible to the next claimant, and end with their Operation", async () => {
  const reservations = createHostReservations();
  const seen: number[][] = [];
  const choose =
    (port: number) => async (reserved: ReadonlyMap<number, unknown>) => {
      seen.push([...reserved.keys()]);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { "web.http": port };
    };
  const owner = { project: "alpha", target: "local" };
  await Promise.all([
    reservations.ports("a").reserve(owner, choose(5000)),
    reservations.ports("b").reserve(owner, choose(5001)),
  ]);
  expect(seen).toEqual([[], [5000]]);
  reservations.release("a");
  await reservations.ports("c").reserve(owner, choose(5002));
  expect(seen.at(-1)).toEqual([5001]);
  // A refused choice claims nothing and does not block the next one.
  await expect(
    reservations.ports("d").reserve(owner, async () => {
      throw new Error("PORT_RESERVED");
    }),
  ).rejects.toThrow("PORT_RESERVED");
  await reservations.ports("e").reserve(owner, choose(5003));
  expect(seen.at(-1)!.sort()).toEqual([5001, 5002]);
});

test("Preview claims are counted per Project, never against their own Operation, and end with it", () => {
  const reservations = createHostReservations();
  reservations.claimPreview("a", "p1", "feature-a");
  reservations.claimPreview("b", "p2", "feature-b");
  expect([...reservations.claimedPreviews("p1", "x")]).toEqual(["feature-a"]);
  expect([...reservations.claimedPreviews("p1", "a")]).toEqual([]);
  reservations.release("a");
  expect([...reservations.claimedPreviews("p1", "x")]).toEqual([]);
});
