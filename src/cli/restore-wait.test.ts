import { expect, test } from "bun:test";
import type { RuntimeCommand } from "../daemon/protocol";
import { restoreOutcome } from "./restore-wait";
import { cliHarness } from "../../tests/support/cli-harness";

const restore: RuntimeCommand = {
  action: "restore",
  repoPath: "/workspace",
  target: "stable",
  job: "db-backup",
  backup: "20261011T030000Z-17",
};
const started = {
  operationId: "op-1",
  project: "melody",
  target: "stable",
  action: "restore",
  outcome: "started",
  job: "db-backup",
  backup: "20261011T030000Z-17",
};
const begun = {
  id: "op-1",
  action: "restore",
  outcome: "started",
  occurredAt: "2026-10-11T09:00:00.000Z",
};
/** rigd's Activity for the Operation: only its start until poll `endsAt`, then also the run's end as `outcome`. */
function activity(outcome: string, endsAt: number) {
  let polls = 0;
  return () => {
    polls++;
    return {
      operations: [
        begun,
        ...(polls >= endsAt
          ? [
              {
                id: "op-1",
                action: "restore",
                outcome,
                occurredAt: "2026-10-11T09:00:05.000Z",
                message: `db-backup: restore ${outcome} in 5s`,
              },
            ]
          : []),
      ],
    };
  };
}

test("a restore is waited for, a second apart, until Activity records its end, and answers restored with that end", async () => {
  const delays: number[] = [];
  const cli = cliHarness({
    command: activity("succeeded", 3),
    wait: async (ms) => void delays.push(ms),
  });
  expect(await restoreOutcome(restore, started, "op-1", cli.deps)).toEqual({
    ...started,
    outcome: "restored",
    ended: {
      id: "op-1",
      action: "restore",
      outcome: "succeeded",
      occurredAt: "2026-10-11T09:00:05.000Z",
      message: "db-backup: restore succeeded in 5s",
    },
  });
  expect(cli.requests).toEqual([
    { action: "activity", operation: "op-1" },
    { action: "activity", operation: "op-1" },
    { action: "activity", operation: "op-1" },
  ]);
  expect(delays).toEqual([1000, 1000]);
  expect(cli.err()).toBe(
    "Restoring db-backup from 20261011T030000Z-17; its output is in rig logs stable --service db-backup.\n",
  );
  expect(cli.out()).toBe("");
});

test("a restore that did not succeed fails RESTORE_FAILED with its message and where its output is", async () => {
  const cli = cliHarness({ command: activity("failed", 1) });
  expect(
    await restoreOutcome(restore, started, "op-1", cli.deps).catch((e) => e),
  ).toMatchObject({
    code: "RESTORE_FAILED",
    message: "db-backup: restore failed in 5s.",
    hint: "Its output is in rig logs stable --service db-backup.",
    details: { operationId: "op-1" },
  });
});

test("a Ctrl-C while waiting stops the wait, leaving the restore running, and says how to see its end", async () => {
  const cancel = new AbortController();
  const cli = cliHarness({
    signal: cancel.signal,
    command: activity("succeeded", 10),
    wait: async () => {
      if (cli.requests.length === 2) cancel.abort();
    },
  });
  expect(
    await restoreOutcome(restore, started, "op-1", cli.deps).catch((e) => e),
  ).toMatchObject({
    code: "DETACHED",
    message: "Stopped waiting; the restore goes on in the background.",
    hint: "rig activity op-1 shows how it ends.",
    details: { operationId: "op-1", oneLine: true },
  });
  expect(cli.requests).toHaveLength(2);
});

test("a restore interrupted before it was waited for says nothing about its output and asks rigd nothing", async () => {
  const cancel = new AbortController();
  cancel.abort();
  const cli = cliHarness({ signal: cancel.signal });
  expect(
    await restoreOutcome(restore, started, "op-1", cli.deps).catch((e) => e),
  ).toMatchObject({ code: "DETACHED" });
  expect(cli.requests).toEqual([]);
  expect(cli.text()).toBe("");
});

test("an Activity read rigd cannot answer is asked again at the next poll", async () => {
  const ended = activity("succeeded", 1);
  const cli = cliHarness({
    command: () => {
      if (cli.requests.length === 1) throw new Error("rigd restarting");
      return ended();
    },
  });
  expect(
    await restoreOutcome(restore, started, "op-1", cli.deps),
  ).toMatchObject({ outcome: "restored" });
  expect(cli.requests).toHaveLength(2);
});

test("a reply that is not a started restore is answered as it is, without waiting", async () => {
  const cli = cliHarness();
  expect(await restoreOutcome(restore, null, "op-1", cli.deps)).toBeNull();
  expect(cli.requests).toEqual([]);
});
