import { expect, test } from "bun:test";
import { waitNotice, waitStatus } from "../src/cli/wait-notice";
import { formatClock } from "../src/cli/stop-display";
import { createHostReservations } from "../src/runtime/host-reservations";

// Local times, so the expected text does not depend on the time zone the tests run in.
const started = new Date(2026, 8, 27, 4, 0, 0);
const now = new Date(2026, 8, 27, 4, 12, 30);
const view = {
  operationId: "op-1",
  action: "down",
  project: "fletcher",
  target: "local",
  phase: "stopping",
  startedAt: started.toISOString(),
};
const waitingOn = (
  holders: object[],
  ahead = 0,
): { operation: { state: "waiting"; waitingOn: object[]; ahead: number } } => ({
  operation: { state: "waiting", waitingOn: holders, ahead },
});

test("the wait line names the Target, what is happening to it, when it started in local time, and how many more are ahead", () => {
  expect(waitNotice(waitingOn([view]), now)).toBe(
    "Waiting: fletcher local is stopping (operation op-1, started 04:00:00)",
  );
  expect(
    waitNotice(
      waitingOn([{ ...view, target: undefined, phase: "renaming" }, view], 2),
      now,
    ),
  ).toBe(
    "Waiting: fletcher is being renamed (operation op-1, started 04:00:00); 3 more ahead of this command",
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
      now,
    ),
  ).toStartWith("Waiting: rigd is preparing to uninstall (operation op-1");
  // A phase this rig does not know yet still reads as the action.
  expect(
    waitNotice(waitingOn([{ ...view, phase: "draining" }]), now),
  ).toStartWith("Waiting: fletcher local is running down (");
  expect(waitNotice(waitingOn([], 1), now)).toBe(
    "Waiting: 1 operation ahead of this command",
  );
});

test("a wait on a stop names the Service being stopped and when it is killed, as time left and local time", () => {
  const killAt = new Date(2026, 8, 27, 4, 31, 7);
  const stopping = {
    ...view,
    stops: [
      {
        service: "web",
        target: "local",
        state: "stopped",
        since: started.toISOString(),
        killAt: started.toISOString(),
        endedAt: started.toISOString(),
      },
      {
        service: "google-scheduler",
        target: "local",
        state: "stopping",
        since: started.toISOString(),
        killAt: killAt.toISOString(),
      },
    ],
  };
  const status = waitStatus(waitingOn([stopping]), now);
  expect(status).toEqual({
    state: "waiting",
    subject: "op-1|stopping|local|google-scheduler",
    killAt: killAt.toISOString(),
    notice:
      "Waiting: fletcher local is stopping (google-scheduler, killing in 19m at 04:31)",
  });
  expect(formatClock(killAt, false)).toBe("04:31");
  expect(waitNotice(waitingOn([stopping]), new Date(2026, 8, 27, 4, 40))).toBe(
    "Waiting: fletcher local is stopping (google-scheduler, killing now)",
  );
});

test("a running Operation reports the Services it is stopping; an unreadable reply reports nothing", () => {
  expect(
    waitStatus({ operation: { state: "running", phase: "starting" } }, now),
  ).toEqual({ state: "running", stops: [] });
  expect(
    waitStatus(
      {
        operation: {
          state: "running",
          phase: "stopping",
          project: "fletcher",
          target: "local",
          stops: view.phase ? [] : [],
        },
      },
      now,
    ),
  ).toEqual({
    state: "running",
    project: "fletcher",
    target: "local",
    stops: [],
  });
  expect(waitStatus({ operation: { state: "unknown" } }, now)).toBeUndefined();
  expect(waitStatus({ running: view, waiting: 1 }, now)).toBeUndefined();
  expect(waitStatus("nonsense", now)).toBeUndefined();
  expect(waitStatus(waitingOn([view]), now)).toMatchObject({
    state: "waiting",
  });
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
