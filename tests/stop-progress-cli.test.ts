import { expect, test } from "bun:test";
import { runRigCli } from "../src/cli/rig";
import {
  formatClock,
  formatDuration,
  plainStopLines,
  stopBoard,
  type PlainStopState,
} from "../src/cli/stop-display";
import { renderStatus } from "../src/cli/output";
import { liveDisplay, plainDisplay } from "../src/cli/progress-display";
import { waitStatus } from "../src/cli/wait-notice";
import type { CliDependencies } from "../src/cli/types";
import type { ServiceStop } from "../src/daemon/protocol";
import type { RuntimeCommand } from "../src/daemon/protocol";

// Local times throughout, so the expected text does not depend on the time zone the tests run in.
const T0 = new Date(2026, 8, 27, 4, 6, 7).getTime();
const at = (ms: number) => new Date(T0 + ms);
const iso = (ms: number) => at(ms).toISOString();
const MINUTE = 60_000;

test("durations read as people say them, and deadlines as local wall-clock time", () => {
  expect(formatDuration(18 * MINUTE + 42_000, "seconds")).toBe("18m 42s");
  expect(formatDuration(42_000, "seconds")).toBe("42s");
  expect(formatDuration(65 * MINUTE + 3_000, "seconds")).toBe("1h 5m 3s");
  expect(formatDuration(24 * MINUTE + 58_000, "minutes")).toBe("25m");
  expect(formatDuration(60 * MINUTE, "minutes")).toBe("1h");
  expect(formatDuration(65 * MINUTE, "minutes")).toBe("1h 5m");
  expect(formatDuration(42_000, "minutes")).toBe("42s");
  expect(formatDuration(-5, "seconds")).toBe("0s");
  expect(formatClock(new Date(2026, 8, 27, 4, 31, 7), true)).toBe("04:31:07");
  expect(formatClock(new Date(2026, 8, 27, 14, 5, 0), false)).toBe("14:05");
});

/** google-scheduler has a 25-minute grace and exits after 6m 18s; web exits at once. */
function stopsAt(ms: number): ServiceStop[] {
  const scheduler: ServiceStop = {
    service: "google-scheduler",
    target: "local",
    state: "stopping",
    since: iso(500),
    killAt: iso(500 + 25 * MINUTE),
  };
  return [
    {
      service: "web",
      target: "local",
      state: "stopped",
      since: iso(0),
      killAt: iso(10_000),
      endedAt: iso(500),
    },
    ...(ms >= 500
      ? [
          ms >= 500 + 378_000
            ? {
                ...scheduler,
                state: "stopped" as const,
                endedAt: iso(500 + 378_000),
              }
            : scheduler,
        ]
      : []),
  ];
}

test("without a terminal, a stop is announced once it has waited 2 s, again every 5 minutes, and when it ends", () => {
  const printed = new Map<string, PlainStopState>();
  const lines: string[] = [];
  for (let ms = 0; ms <= 400_000; ms += 1000)
    lines.push(...plainStopLines(printed, stopsAt(ms), at(ms)));
  expect(lines).toEqual([
    "google-scheduler stopping, killing in 25m (04:31:07)",
    "google-scheduler stopping, killing in 20m (04:31:07)",
    "google-scheduler stopped after 6m 18s",
  ]);
});

test("without a terminal, a stop gets one more line when a minute is left, then says it was killed", () => {
  const printed = new Map<string, PlainStopState>();
  const stop: ServiceStop = {
    service: "worker",
    target: "live",
    state: "stopping",
    since: iso(0),
    killAt: iso(3 * MINUTE),
  };
  const lines: string[] = [];
  for (let ms = 0; ms < 3 * MINUTE; ms += 1000)
    lines.push(...plainStopLines(printed, [stop], at(ms)));
  lines.push(
    ...plainStopLines(
      printed,
      [
        {
          ...stop,
          state: "stopped",
          killed: "timeout",
          endedAt: iso(3 * MINUTE + 100),
        },
      ],
      at(3 * MINUTE + 500),
    ),
  );
  expect(lines).toEqual([
    "worker stopping, killing in 3m (04:09:07)",
    "worker stopping, killing in 1m (04:09:07)",
    "worker stopped after timeout (SIGKILL) after 3m 0s",
  ]);
  // A grace shorter than a minute is announced once: its first line already says less than a minute.
  const short = new Map<string, PlainStopState>();
  const quick: ServiceStop = { ...stop, killAt: iso(10_000) };
  const said: string[] = [];
  for (let ms = 0; ms < 10_000; ms += 1000)
    said.push(...plainStopLines(short, [quick], at(ms)));
  expect(said).toEqual(["worker stopping, killing in 8s (04:06:17)"]);
});

test("the terminal board lists each Service under its Target, with a countdown while it stops and the Ctrl-C hint", () => {
  const stops: ServiceStop[] = [
    {
      service: "web",
      target: "local",
      state: "stopped",
      since: iso(0),
      killAt: iso(10_000),
      endedAt: iso(3000),
    },
    {
      service: "google-scheduler",
      target: "local",
      state: "stopping",
      since: iso(3000),
      killAt: iso(25 * MINUTE),
    },
  ];
  expect(stopBoard("fletcher", stops, at(6 * MINUTE + 18_000))).toEqual([
    "Stopping fletcher local",
    "  web                 stopped",
    "  google-scheduler    stopping · killing in 18m 42s (04:31:07)",
    "  (Ctrl-C to leave it stopping in the background)",
  ]);
  // Nothing is shown before a stop has waited 2 s.
  expect(stopBoard("fletcher", stops.slice(1), at(4000))).toEqual([]);
});

test("rig status shows a stopping Service with its kill deadline, and the Target as stopping", () => {
  const text = renderStatus(
    {
      project: "fletcher",
      targets: [
        {
          name: "local",
          kind: "local",
          state: "stopping",
          components: [
            { name: "web", kind: "managed", state: "stopped" },
            {
              name: "google-scheduler",
              kind: "managed",
              state: "stopping",
              killAt: iso(25 * MINUTE),
            },
          ],
        },
      ],
    },
    at(7 * MINUTE),
  );
  expect(text).toContain("local  stopping  working copy");
  expect(text).toContain(
    "  google-scheduler  stopping · killing in 18m (04:31)",
  );
});

/** rig down against a scripted rigd whose clock is the test's: the Operation stops web at once and google-scheduler after
 * 6m 18s. `wait` moves the clock, so minutes pass instantly. */
function scripted(options: { live: boolean; interruptAt?: number }) {
  let clock = T0;
  let errors = "";
  let text = "";
  const requests: RuntimeCommand[] = [];
  let finish: ((value: unknown) => void) | undefined;
  const cancel = new AbortController();
  const detach = new AbortController();
  const result = (ms: number) => ({
    project: "fletcher",
    target: "local",
    action: "down",
    outcome: "stopped",
    operationId: "down-1",
    stops: stopsAt(ms),
  });
  const dependencies: CliDependencies = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    signal: cancel.signal,
    detach: detach.signal,
    now: () => new Date(clock),
    liveOutput: options.live,
    wait: async (ms) => {
      clock += ms;
      if (
        options.interruptAt !== undefined &&
        clock - T0 >= options.interruptAt
      )
        cancel.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    client: {
      async status() {
        throw new Error("unexpected status");
      },
      command(request, signal) {
        requests.push(request);
        if (request.action === "queue") {
          const ms = clock - T0;
          if (ms >= 500 + 378_000) finish?.(result(ms));
          return Promise.resolve({
            operation: {
              state: "running",
              phase: "stopping",
              project: "fletcher",
              target: "local",
              stops: stopsAt(ms),
            },
          });
        }
        signal?.addEventListener("abort", () => {});
        return new Promise((resolve) => (finish = resolve));
      },
    },
    output: {
      write(value) {
        text += value;
      },
      error(value) {
        errors += value;
      },
    },
    diagnostics: {
      async record() {
        return {};
      },
    },
    newOperationId: () => "down-1",
  };
  return {
    run: (args: string[]) => runRigCli(args, dependencies),
    requests,
    errors: () => errors,
    text: () => text,
  };
}

test("rig down without a terminal prints plain appended lines once the stop has waited about 2 s, and never moves the cursor", async () => {
  const cli = scripted({ live: false });
  expect(await cli.run(["down", "local"])).toBe(0);
  expect(cli.errors()).toBe(
    [
      "google-scheduler stopping, killing in 25m (04:31:07)",
      "google-scheduler stopping, killing in 20m (04:31:07)",
      "google-scheduler stopped after 6m 18s",
      "",
    ].join("\n"),
  );
  expect(cli.errors()).not.toContain("\x1b");
  expect(cli.errors()).not.toContain("\r");
  expect(cli.text()).toContain("fletcher local stopped");
});

test("rig down on a terminal redraws one board in place with a countdown, and leaves the final states", async () => {
  const cli = scripted({ live: true });
  expect(await cli.run(["down", "local"])).toBe(0);
  const errors = cli.errors();
  // The first frame, once the slow stop has waited 2 s, lists web, which stopped at once, beside it; each later frame first
  // moves up over the previous one and clears it.
  expect(errors).toStartWith(
    "Stopping fletcher local\n  web                 stopped\n  google-scheduler    stopping · killing in 24m 58s (04:31:07)\n  (Ctrl-C to leave it stopping in the background)\n",
  );
  expect(errors).toContain(
    "\x1b[4A\r\x1b[JStopping fletcher local\n  web                 stopped\n  google-scheduler    stopping · killing in 24m 57s (04:31:07)\n",
  );
  expect(errors).toEndWith(
    "\x1b[4A\r\x1b[JStopping fletcher local\n  web                 stopped\n  google-scheduler    stopped\n",
  );
});

test("a terminal line wider than the terminal is cut, so a redraw moves up exactly the rows it drew", () => {
  let text = "";
  const display = liveDisplay({ error: (value) => (text += value) }, 40);
  const status = {
    state: "waiting" as const,
    subject: "a",
    notice:
      "Waiting: fletcher local is deploying (operation 0b1f2c3d-aaaa-bbbb-cccc-000000000000, started 04:00:00)",
  };
  display.show(status, at(0));
  display.show({ ...status, subject: "b", notice: "Waiting: short" }, at(1000));
  expect(text).toBe(
    "Waiting: fletcher local is deploying (…\n\x1b[1A\r\x1b[JWaiting: short\n",
  );
});

test("a command that fails while a Service is still stopping leaves it shown as stopping in rigd, without a countdown", () => {
  let live = "";
  let plain = "";
  const onTerminal = liveDisplay({ error: (value) => (live += value) });
  const inPipe = plainDisplay({ error: (value) => (plain += value) });
  const status = {
    state: "running" as const,
    project: "fletcher",
    stops: stopsAt(60_000),
  };
  onTerminal.show(status, at(60_000));
  inPipe.show(status, at(60_000));
  onTerminal.abandon(at(61_000), false);
  inPipe.abandon(at(61_000), false);
  expect(live).toEndWith(
    "\x1b[4A\r\x1b[JStopping fletcher local\n  web                 stopped\n  google-scheduler    still stopping in rigd (killing at 04:31:07)\n",
  );
  expect(plain).toBe(
    "google-scheduler stopping, killing in 24m (04:31:07)\ngoogle-scheduler still stopping in rigd (killing at 04:31:07)\n",
  );
});

test("Ctrl-C while a stop is shown leaves it stopping in rigd, says when it is killed, and how to kill it now", async () => {
  const cli = scripted({ live: false, interruptAt: 60_000 });
  expect(await cli.run(["down", "local"])).toBe(130);
  expect(cli.errors()).toEndWith(
    "google-scheduler stopping, killing in 25m (04:31:07)\n" +
      "Left google-scheduler stopping in the background (killing at 04:31). Run rig down local --kill to stop it now.\n",
  );
  // The command was not cancelled in rigd: nothing but the down and its progress reads was sent.
  expect(new Set(cli.requests.map((request) => request.action))).toEqual(
    new Set(["down", "queue"]),
  );
});

test("--kill is sent by rig down and rig restart, and rig up has no such option", async () => {
  for (const action of ["down", "restart"]) {
    const cli = scripted({ live: false });
    const run = cli.run([action, "local", "--kill"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cli.requests[0]).toMatchObject({
      action,
      target: "local",
      kill: true,
    });
    void run;
  }
  const cli = scripted({ live: false });
  expect(await cli.run(["up", "local", "--kill"])).toBe(1);
  expect(cli.errors()).toContain("unknown option '--kill'");
});

test("a command waiting behind a stop updates its one line in place on a terminal, and without one prints it on change, every 5 minutes and a minute before the kill", () => {
  const reply = {
    operation: {
      state: "waiting",
      ahead: 0,
      waitingOn: [
        {
          operationId: "down-1",
          action: "down",
          project: "fletcher",
          target: "local",
          phase: "stopping",
          startedAt: iso(0),
          stops: [
            {
              service: "google-scheduler",
              target: "local",
              state: "stopping",
              since: iso(0),
              killAt: iso(25 * MINUTE),
            },
          ],
        },
      ],
    },
  };
  let live = "";
  let plain = "";
  const onTerminal = liveDisplay({ error: (value) => (live += value) });
  const inPipe = plainDisplay({ error: (value) => (plain += value) });
  for (let ms = 7 * MINUTE; ms < 25 * MINUTE; ms += 1000) {
    const status = waitStatus(reply, at(ms))!;
    onTerminal.show(status, at(ms));
    inPipe.show(status, at(ms));
  }
  expect(live).toStartWith(
    "Waiting: fletcher local is stopping (google-scheduler, killing in 18m at 04:31)\n\x1b[1A\r\x1b[JWaiting:",
  );
  expect(plain.split("\n")).toEqual([
    "Waiting: fletcher local is stopping (google-scheduler, killing in 18m at 04:31)",
    "Waiting: fletcher local is stopping (google-scheduler, killing in 13m at 04:31)",
    "Waiting: fletcher local is stopping (google-scheduler, killing in 8m at 04:31)",
    "Waiting: fletcher local is stopping (google-scheduler, killing in 3m at 04:31)",
    "Waiting: fletcher local is stopping (google-scheduler, killing in 1m at 04:31)",
    "",
  ]);
});
