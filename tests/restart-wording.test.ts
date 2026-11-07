import { expect, test } from "bun:test";
import type { ManagedComponent } from "../src/config/types";
import { RigError } from "../src/domain/errors";
import {
  describeExit,
  exhaustedActivity,
  exitActivity,
  failedAttemptActivity,
  restartedActivity,
  runningNote,
  stoppedStanding,
  waitingActivity,
} from "../src/domain/restart-wording";
import type { ServiceRun, TargetRecord } from "../src/domain/runtime";

const at = "2026-11-07T12:00:00.000Z";
const web = {
  kind: "managed",
  name: "web",
  restart: "on-failure",
} as ManagedComponent;
const target = (run?: Partial<ServiceRun>, desired = "running") =>
  ({
    kind: "stable",
    name: "stable",
    desired,
    plan: { project: "demo", workspacePath: "/work", components: [web] },
    services: run
      ? {
          web: {
            deployment: "/work",
            intent: "running",
            incarnation: "i1",
            attempts: [],
            ...run,
          },
        }
      : {},
  }) as unknown as TargetRecord;
const stopped = { state: "stopped" } as const;

test("stoppedStanding reports a requested stop, and one that needed SIGKILL", () => {
  expect(stoppedStanding(target({}, "stopped"), web, stopped)).toEqual({
    state: "stopped",
    exit: "requested",
  });
  expect(
    stoppedStanding(
      target({ intent: "stopped", stopKilled: "timeout" }),
      web,
      stopped,
    ),
  ).toEqual({
    state: "stopped",
    exit: "requested",
    signal: "SIGKILL",
    reason:
      "Stopped after timeout (SIGKILL): it did not exit within its stop_timeout.",
  });
  expect(stoppedStanding(target(undefined, "stopped"), web, stopped)).toEqual({
    state: "stopped",
  });
});

test("stoppedStanding explains a crash under each policy and budget", () => {
  const crash = { kind: "exited", exitCode: 1, at } as const;
  expect(stoppedStanding(target({ outcome: crash }), web, stopped)).toEqual({
    state: "starting",
    exit: "failed",
    exitCode: 1,
    reason:
      "The process exited with code 1; an automatic restart is scheduled.",
  });
  const standing = stoppedStanding(
    target({ outcome: crash, exhausted: true }),
    web,
    stopped,
  );
  expect(standing.state).toBe("failed");
  expect(standing.reason).toStartWith(
    "The process exited with code 1 after 5 automatic restarts within 60 s, so it stays stopped. Run rig up ",
  );
  expect(
    stoppedStanding(
      target({ outcome: { kind: "exited", exitCode: 0, at } }),
      web,
      stopped,
    ).reason,
  ).toStartWith(
    "The process exited with code 0 and its restart policy is on-failure, so it stays stopped. Run rig up ",
  );
  expect(
    stoppedStanding(
      target({ outcome: crash, waitingFor: { ports: [3000, 3001] } }),
      web,
      stopped,
    ).reason,
  ).toBe(
    "The process exited with code 1; waiting for ports 3000, 3001, which still accept connections, to be free.",
  );
});

test("stoppedStanding explains an unknown exit, with and without a Host restart", () => {
  const always = { ...web, restart: undefined } as ManagedComponent;
  expect(
    stoppedStanding(
      target({ outcome: { kind: "unknown", at } }),
      always,
      stopped,
    ),
  ).toEqual({
    state: "starting",
    exit: "unknown",
    reason:
      "The process is not running and nothing recorded how it ended; under restart: always it is started again once it is verified gone and its ports are free (an automatic restart is scheduled).",
  });
  expect(
    stoppedStanding(
      target({ outcome: { kind: "unknown", at }, exhausted: true }),
      always,
      stopped,
    ).reason,
  ).toStartWith(
    "The process is not running and nothing recorded how it ended, and it ended with nothing recorded about how after its 3 automatic restarts for unknown exits within 10 min, so it stays stopped.",
  );
  const restarted = stoppedStanding(
    target({ outcome: { kind: "unknown", hostRestart: "reboot", at } }),
    always,
    stopped,
  );
  expect(restarted.state).toBe("stopped");
  expect(restarted.reason).toContain(
    "Only stable Targets are started again after that; the working Target and Previews stay stopped.",
  );
  // Nothing recorded yet: the observation alone says it ended unseen.
  expect(stoppedStanding(target({}), web, stopped)).toMatchObject({
    state: "failed",
    exit: "unknown",
  });
});

test("runningNote speaks only of the process the noted start made", () => {
  expect(
    runningNote(target({ restartedAfterUnknown: true }), web, {
      state: "running",
      incarnation: "i1",
    }),
  ).toBe(
    "Started again automatically after its previous process ended with nothing recorded about how (unknown exit, restarted).",
  );
  expect(
    runningNote(target({ startedAfterHostRestart: "login" }), web, {
      state: "running",
      incarnation: "i1",
    }),
  ).toEndWith("(restarted after login).");
  expect(
    runningNote(target({ restartedAfterUnknown: true }), web, {
      state: "running",
      incarnation: "other",
    }),
  ).toBeUndefined();
  expect(
    runningNote(target({}), web, { state: "running", incarnation: "i1" }),
  ).toBeUndefined();
});

test("exitActivity names how the process ended and whether it is started again", () => {
  expect(
    exitActivity("web", { kind: "exited", exitCode: 0, at }, undefined),
  ).toEqual({
    action: "exit",
    outcome: "stopped",
    message: "web exited with code 0.",
  });
  expect(
    exitActivity(
      "web",
      { kind: "exited", signal: "SIGKILL", at },
      "known-exit",
    ),
  ).toEqual({
    action: "crash",
    outcome: "failed",
    message: "web was ended by SIGKILL.",
  });
  expect(exitActivity("web", { kind: "unknown", at }, "unknown-exit")).toEqual({
    action: "exit",
    outcome: "failed",
    message:
      "web is not running and nothing recorded how it ended; under restart: always it is started again once it is verified gone and its ports are free.",
  });
  expect(exitActivity("web", { kind: "unknown", at }, undefined).message).toBe(
    "web is not running and nothing recorded how it ended, so it was not started again.",
  );
});

test("the restart Activity entries say which budget and attempt", () => {
  expect(exhaustedActivity("web", "known-exit", target()).message).toStartWith(
    "web used its 5 automatic restarts within 60 s and stays stopped. Run rig restart ",
  );
  expect(exhaustedActivity("web", "unknown-exit", target())).toMatchObject({
    action: "restart",
    outcome: "failed",
  });
  expect(
    failedAttemptActivity("web", new RigError("PROCESS_EXITED", "", "")),
  ).toEqual({
    action: "restart",
    outcome: "failed",
    message: "web could not be started again automatically (PROCESS_EXITED).",
  });
  expect(waitingActivity("web", { service: "db" })).toEqual({
    action: "restart",
    outcome: "unchanged",
    message:
      "web is not started again yet: waiting for db, which it depends on, to be running. Waiting spends none of its automatic restarts.",
  });
  expect(waitingActivity("web", { ports: [3000] }).message).toContain(
    "waiting for port 3000, which still accepts connections, to be free",
  );
  expect(restartedActivity("web", "known-exit", 2)).toEqual({
    action: "restart",
    outcome: "started",
    message:
      "web was started again automatically (attempt 2 of 5 within 60 s).",
  });
  expect(restartedActivity("web", "unknown-exit", 1).message).toBe(
    "web ended with nothing recorded about how and was started again automatically (unknown exit, restarted: attempt 1 of 3 within 10 min).",
  );
});

test("describeExit names the witness of an end the application did not record", () => {
  expect(describeExit({ kind: "exited", exitCode: 3, at })).toBe(
    "exited with code 3",
  );
  expect(
    describeExit({ kind: "exited", signal: "SIGTERM", recordedBy: "rigd", at }),
  ).toBe("was ended by SIGTERM (from rigd's record of its capture wrapper)");
  expect(
    describeExit({ kind: "exited", exitCode: 1, recordedBy: "launchd", at }),
  ).toBe("exited with code 1 (from launchd's record of its job)");
});
