import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  hostRestartBetween,
  identified,
  mayReplace,
} from "../src/domain/host-session";
import { findHostRestart } from "../src/runtime/host-restart";
import {
  createHostSessionProbe,
  parseBootSession,
  parseBootTime,
  parseLoginSession,
} from "../src/providers/host-session";
import type { CommandRequest, CommandResult } from "../src/providers/contracts";

const BOOT = "D5235692-F7BA-44AF-90B0-3F51D44808BB";
const recorded = {
  boot: BOOT,
  bootedAt: "2026-05-24T20:57:56.781Z",
  login: "100002",
};

test("a different boot is a reboot, a different login in the same boot is a new login, and the same session is no restart", () => {
  expect(hostRestartBetween(recorded, { ...recorded })).toBeUndefined();
  expect(
    hostRestartBetween(recorded, {
      ...recorded,
      boot: "OTHER",
      login: "100002",
    }),
  ).toBe("reboot");
  expect(hostRestartBetween(recorded, { ...recorded, login: "100019" })).toBe(
    "login",
  );
  // The boot time the kernel shifts on a clock correction decides nothing.
  expect(
    hostRestartBetween(recorded, {
      ...recorded,
      bootedAt: "2026-05-24T20:58:01.000Z",
    }),
  ).toBeUndefined();
});

test("nothing recorded, or a side that could not be read, detects nothing it cannot prove", () => {
  expect(hostRestartBetween(undefined, recorded)).toBeUndefined();
  expect(hostRestartBetween(recorded, {})).toBeUndefined();
  expect(
    hostRestartBetween({ login: "100002" }, { boot: BOOT }),
  ).toBeUndefined();
  // A new login is a new login even when the boot could not be read on one side.
  expect(hostRestartBetween(recorded, { login: "100019" })).toBe("login");
});

test("a session counts as identified by its boot or its login", () => {
  expect(identified({})).toBe(false);
  expect(identified({ bootedAt: recorded.bootedAt })).toBe(false);
  expect(identified({ login: "100019" })).toBe(true);
});

test("a restart found earlier and not finished is the same one while nothing changed since, whatever each read could see, and a change since is a new restart", () => {
  const host = (restart: Record<string, unknown>) => ({
    host: { ...recorded, seenAt: "2026-09-27T08:00:00.000Z", restart },
  }) as Parameters<typeof findHostRestart>[0];
  // Found with only the boot readable; read again with the login too.
  const reboot = host({ kind: "reboot", boot: "NEW-BOOT", settled: ["t1"] });
  expect(
    findHostRestart(reboot, { boot: "NEW-BOOT", login: "100019" }),
  ).toMatchObject({ restart: "reboot", announced: true });
  expect([
    ...findHostRestart(reboot, { boot: "NEW-BOOT" }).settled,
  ]).toEqual(["t1"]);
  // Found with only the login readable; read again with the new boot too: the same event keeps its kind.
  const login = host({ kind: "login", login: "100019" });
  expect(
    findHostRestart(login, { boot: "NEW-BOOT", login: "100019" }),
  ).toMatchObject({ restart: "login", announced: true });
  // A logout and login since the pending reboot is a new restart, announced, with nothing settled.
  const later = findHostRestart(
    host({ kind: "reboot", boot: "NEW-BOOT", login: "100019", settled: ["t1"] }),
    { boot: "NEW-BOOT", login: "100020" },
  );
  expect(later).toMatchObject({ restart: "login", announced: false });
  expect(later.settled.size).toBe(0);
  // Nothing readable now: the pending restart is still the one to act on, and it is recorded as it was found.
  const pendingBoth = host({
    kind: "reboot",
    boot: "NEW-BOOT",
    login: "100019",
    settled: ["t1"],
  });
  expect(findHostRestart(pendingBoth, {})).toMatchObject({
    restart: "reboot",
    announced: true,
    record: true,
    session: { boot: "NEW-BOOT", login: "100019" },
  });
  // A read that missed the login keeps the one read when the restart was found, so a later logout can be told.
  expect(
    findHostRestart(pendingBoth, { boot: "NEW-BOOT", bootedAt: "2026-09-27T07:59:00.000Z" })
      .session,
  ).toEqual({
    boot: "NEW-BOOT",
    bootedAt: "2026-09-27T07:59:00.000Z",
    login: "100019",
  });
});

test("a read with no restart replaces the recorded session only when it read everything the recorded one names", () => {
  expect(mayReplace(recorded, recorded)).toBe(true);
  expect(mayReplace(undefined, { login: "100002" })).toBe(true);
  expect(mayReplace(recorded, { login: "100002" })).toBe(false);
  expect(mayReplace(recorded, { boot: BOOT })).toBe(false);
  expect(mayReplace({ boot: BOOT }, { boot: BOOT, login: "100002" })).toBe(
    true,
  );
  expect(mayReplace(undefined, {})).toBe(false);
});

test("the parsers read sysctl and launchctl output and nothing else", async () => {
  expect(parseBootSession(`${BOOT.toLowerCase()}\n`)).toBe(BOOT);
  expect(
    parseBootSession("sysctl: unknown oid 'kern.bootsessionuuid'"),
  ).toBeUndefined();
  expect(
    parseBootTime(
      "{ sec = 1779656276, usec = 781635 } Sun May 24 16:57:56 2026\n",
    ),
  ).toBe("2026-05-24T20:57:56.781Z");
  expect(parseBootTime("")).toBeUndefined();
  const gui = await readFile(
    join(import.meta.dir, "fixtures", "launchctl-print", "gui-domain.txt"),
    "utf8",
  );
  expect(parseLoginSession(gui)).toBe("100007");
  // A job's own print has no domain security context.
  const job = await readFile(
    join(import.meta.dir, "fixtures", "launchctl-print", "running.txt"),
    "utf8",
  );
  expect(parseLoginSession(job)).toBeUndefined();
});

test("the probe reads each part on its own, leaves out what fails, and never rejects", async () => {
  const gui = await readFile(
    join(import.meta.dir, "fixtures", "launchctl-print", "gui-domain.txt"),
    "utf8",
  );
  const asked: string[] = [];
  const answers: Record<string, CommandResult | Error> = {
    "kern.bootsessionuuid": { exitCode: 0, stdout: `${BOOT}\n`, stderr: "" },
    "kern.boottime": {
      exitCode: 0,
      stdout: "{ sec = 1779656276, usec = 781635 } Sun May 24 16:57:56 2026\n",
      stderr: "",
    },
    "gui/501": { exitCode: 0, stdout: gui, stderr: "" },
  };
  const run = async (request: CommandRequest): Promise<CommandResult> => {
    const subject = request.command.at(-1)!;
    asked.push(request.command.join(" "));
    const answer = answers[subject]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const probe = createHostSessionProbe({ run, uid: 501 });
  expect(await probe.current()).toEqual({
    boot: BOOT,
    bootedAt: "2026-05-24T20:57:56.781Z",
    login: "100007",
  });
  expect(asked.sort()).toEqual([
    "/bin/launchctl print gui/501",
    "/usr/sbin/sysctl -n kern.bootsessionuuid",
    "/usr/sbin/sysctl -n kern.boottime",
  ]);

  // No GUI login (launchctl cannot find the domain), a command that timed out, and one that could not run.
  answers["gui/501"] = {
    exitCode: 113,
    stdout: "",
    stderr: "Could not find domain for port identifier.",
  };
  answers["kern.boottime"] = {
    exitCode: 1,
    stdout: "",
    stderr: "",
    timedOut: true,
  };
  answers["kern.bootsessionuuid"] = new Error("spawn failed");
  expect(await probe.current()).toEqual({});
});
