import { expect, test } from "bun:test";
import { RigError } from "../domain/errors";
import type { RuntimeCommand } from "../daemon/protocol";
import { awaitMutation } from "./mutation-wait";
import { formatClock } from "./stop-display";
import { cliHarness } from "../../tests/support/cli-harness";

const T0 = new Date(2026, 8, 27, 4, 6, 7).getTime();
const up: RuntimeCommand = {
  action: "up",
  target: "working",
  repoPath: "/workspace",
  operationId: "op-1",
};
const answered = {
  project: "beta",
  target: "working",
  action: "up",
  outcome: "started",
  operationId: "op-1",
};

/** A wait that only ends once its signal aborts, so nothing happens on its own; records each delay asked for. */
function heldWaits() {
  const delays: number[] = [];
  return {
    delays,
    wait: (ms: number, signal?: AbortSignal) => {
      delays.push(ms);
      return new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  };
}

test("a mutation rigd answers before the notice delay resolves its answer with nothing shown and no queue poll", async () => {
  const held = heldWaits();
  const cli = cliHarness({ command: () => answered, wait: held.wait });
  expect(await awaitMutation(up, cli.deps, "op-1")).toEqual(answered);
  expect(cli.requests).toEqual([up]);
  expect(held.delays).toEqual([2000]);
  expect(cli.text()).toBe("");
});

test("a mutation rigd holds is shown waiting after 2 s, then asked about every second until it answers", async () => {
  let clock = T0;
  let finish!: (value: unknown) => void;
  const behind = {
    operationId: "op-0",
    action: "down",
    project: "beta",
    target: "working",
    phase: "stopping",
    startedAt: new Date(T0).toISOString(),
  };
  const delays: number[] = [];
  const cli = cliHarness({
    now: () => new Date(clock),
    wait: async (ms) => {
      delays.push(ms);
      clock += ms;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    command: (request) => {
      if (request.action !== "queue")
        return new Promise((resolve) => (finish = resolve));
      if (cli.requests.length === 4) finish(answered);
      return {
        waiting: 1,
        operations: [],
        operation: { state: "waiting", waitingOn: [behind], ahead: 0 },
      };
    },
  });
  expect(await awaitMutation(up, cli.deps, "op-1")).toEqual(answered);
  expect(cli.requests.map((request) => request.action)).toEqual([
    "up",
    "queue",
    "queue",
    "queue",
  ]);
  expect(cli.requests[1]).toEqual({ action: "queue", operation: "op-1" });
  expect(delays.slice(0, 3)).toEqual([2000, 1000, 1000]);
  expect(cli.err()).toBe(
    `Waiting: beta working is stopping (operation op-0, started ${formatClock(new Date(T0), true)})\n`,
  );
  expect(cli.out()).toBe("");
});

test("a first Ctrl-C after submission is acknowledged and the wait goes on; detaching then fails DETACHED naming the Operation", async () => {
  const cancel = new AbortController();
  const detach = new AbortController();
  let submitted: AbortSignal | undefined;
  const cli = cliHarness({
    signal: cancel.signal,
    detach: detach.signal,
    wait: heldWaits().wait,
    command: (request, signal) => {
      if (request.action === "queue") return {};
      submitted = signal;
      return new Promise(() => {});
    },
  });
  const waiting = awaitMutation(up, cli.deps, "op-1");
  cancel.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(cli.err()).toBe(
    "rigd is still running up (operation op-1); it finishes in the background. Press Ctrl-C again to detach.\n",
  );
  expect(submitted?.aborted).toBe(false);
  detach.abort();
  const error = await waiting.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(RigError);
  expect(error).toMatchObject({
    code: "DETACHED",
    message: "Detached from operation op-1.",
    hint: "Run rig activity op-1.",
    details: { operationId: "op-1" },
  });
  expect(submitted?.aborted).toBe(true);
});

test("a Ctrl-C while a stop is shown leaves it stopping at once, naming its kill time and how to end it now", async () => {
  let clock = T0;
  const cancel = new AbortController();
  const stop = {
    service: "worker",
    target: "working",
    state: "stopping" as const,
    since: new Date(T0).toISOString(),
    killAt: new Date(T0 + 25 * 60_000).toISOString(),
  };
  let submitted: AbortSignal | undefined;
  const cli = cliHarness({
    signal: cancel.signal,
    now: () => new Date(clock),
    wait: async (ms) => {
      clock += ms;
      if (clock - T0 >= 4000) cancel.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    command: (request, signal) => {
      if (request.action === "queue")
        return {
          operation: {
            state: "running",
            phase: "stopping",
            project: "fletcher",
            target: "working",
            stops: [stop],
          },
        };
      submitted = signal;
      return new Promise(() => {});
    },
  });
  const error = await awaitMutation(
    { ...up, action: "down", project: "fletcher" },
    cli.deps,
    "op-1",
  ).catch((failure: unknown) => failure);
  expect(error).toMatchObject({
    code: "DETACHED",
    message: `Left worker stopping in the background (killing at ${formatClock(new Date(T0 + 25 * 60_000), false)}).`,
    hint: "Run rig down working --project fletcher --kill to stop it now.",
    details: { operationId: "op-1", oneLine: true },
  });
  expect(submitted?.aborted).toBe(true);
});

test("a mutation rigd refuses fails with rigd's error", async () => {
  const refused = new RigError(
    "PORT_RESERVED",
    "Port 3000 is taken.",
    "Free it.",
  );
  const cli = cliHarness({
    command: () => {
      throw refused;
    },
    wait: heldWaits().wait,
  });
  expect(await awaitMutation(up, cli.deps, "op-1").catch((e) => e)).toBe(
    refused,
  );
});
