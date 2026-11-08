import { expect, test } from "bun:test";
import { RigError } from "../domain/errors";
import type { RuntimeCommand } from "../daemon/protocol";
import { followLogs } from "./log-follow";
import { cliHarness } from "../../tests/support/cli-harness";

const request: RuntimeCommand = {
  action: "logs",
  repoPath: "/workspace",
  target: "stable",
  lines: 20,
  operationId: "op-1",
};
const entry = (second: number, line: string) => ({
  timestamp: `2026-09-09T09:42:${second}Z`,
  component: "web",
  stream: "stdout",
  line,
});

/** A follow whose Ctrl-C comes at wait `stopAt`, answering each page with `pages[n]`. */
function follow(stopAt: number, pages: unknown[]) {
  const stop = new AbortController();
  const delays: number[] = [];
  const cli = cliHarness({
    signal: stop.signal,
    wait: async (ms) => {
      delays.push(ms);
      if (delays.length === stopAt) stop.abort();
    },
    command: () => pages[cli.requests.length - 1],
  });
  return { cli, delays };
}

test("a follow asks for 1000 entries after each page's cursor every 250 ms, and prints each page without a heading", async () => {
  const { cli, delays } = follow(3, [
    { entries: [entry(12, "two")], cursor: "c2" },
    { entries: [], cursor: "c3" },
  ]);
  await followLogs(request, { cursor: "c1" }, cli.deps, {
    json: false,
    full: false,
  });
  expect(delays).toEqual([250, 250, 250]);
  expect(cli.requests).toEqual([
    { ...request, lines: 1000, after: "c1" },
    { ...request, lines: 1000, after: "c2" },
  ]);
  expect(cli.out()).toBe("09:42:12Z  web  > two\n");
});

test("a page with no cursor is followed from where rigd chooses, and --json prints JSON Lines", async () => {
  const { cli } = follow(2, [{ entries: [entry(13, "three")] }]);
  await followLogs(request, {}, cli.deps, { json: true, full: false });
  expect(cli.requests).toEqual([{ ...request, lines: 1000 }]);
  expect(cli.out()).toBe(`${JSON.stringify(entry(13, "three"))}\n`);
});

test("long lines are shortened unless --full", async () => {
  const long = "x".repeat(5000);
  for (const full of [false, true]) {
    const { cli } = follow(2, [{ entries: [entry(14, long)], cursor: "c" }]);
    await followLogs(request, {}, cli.deps, { json: true, full });
    const printed = JSON.parse(cli.out());
    expect(printed.line.length < long.length).toBe(!full);
    expect(printed.omitted === undefined).toBe(full);
  }
});

test("the next page waits until the reader took the one before", async () => {
  let release!: () => void;
  const stop = new AbortController();
  let waits = 0;
  const cli = cliHarness({
    signal: stop.signal,
    wait: async () => {
      if (++waits === 2) stop.abort();
    },
    command: () => ({ entries: [entry(15, "slow")], cursor: "c" }),
    output: {
      write: () => new Promise<void>((resolve) => (release = resolve)),
    },
  });
  const following = followLogs(request, {}, cli.deps, {
    json: false,
    full: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(waits).toBe(1);
  release();
  await following;
  expect(waits).toBe(2);
});

test("a read Ctrl-C abandoned ends the follow quietly; any other failure is the follow's", async () => {
  const stop = new AbortController();
  const cancelled = cliHarness({
    signal: stop.signal,
    command: () => {
      stop.abort();
      throw new RigError("CANCELLED", "The read was cancelled.", "Retry.");
    },
  });
  await followLogs(request, {}, cancelled.deps, { json: false, full: false });
  expect(cancelled.out()).toBe("");
  const failure = new Error("rigd failed");
  const failing = cliHarness({
    command: () => {
      throw failure;
    },
  });
  expect(
    await followLogs(request, {}, failing.deps, {
      json: false,
      full: false,
    }).catch((e) => e),
  ).toBe(failure);
});

test("a follow already cancelled asks rigd nothing", async () => {
  const stop = new AbortController();
  stop.abort();
  const cli = cliHarness({ signal: stop.signal });
  await followLogs(request, { cursor: "c1" }, cli.deps, {
    json: false,
    full: false,
  });
  expect(cli.requests).toEqual([]);
});
