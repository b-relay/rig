import { expect, test } from "bun:test";
import {
  rigdSystemPlist,
  systemEnvironment,
  systemInstallRequired,
  systemJobsRemain,
  systemRemovalRequired,
  unstableProgramWarning,
} from "../src/daemon/admin-system-jobs";
import { rigdJobLabel } from "../src/daemon/admin-launch-agent";
import {
  systemInstallLine,
  systemRemoveLine,
  type SystemJob,
} from "../src/domain/system-install";

const places = { staging: "/tmp/staging", daemons: "/tmp/daemons" };

test("the system job's environment is fixed: the user's account, a fixed PATH and the system mode", () => {
  expect(
    systemEnvironment({ root: "/rig", userHome: "/Users/me", userName: "me" }),
  ).toEqual({
    HOME: "/Users/me",
    USER: "me",
    LOGNAME: "me",
    LANG: "en_US.UTF-8",
    PATH: "/rig/bin:/Users/me/.bun/bin:/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    RIG_ROOT: "/rig",
    RIG_DAEMON_CHILD: "1",
    RIG_DAEMON_MODE: "system",
  });
});

test("the rigd system plist keeps its program alive and runs it as the user in group staff", () => {
  const plist = rigdSystemPlist({
    root: "/rig",
    command: ["/rig/bin/rigd"],
    userHome: "/Users/me",
    userName: "me",
  });
  expect(plist).toContain(`<string>${rigdJobLabel("/rig")}</string>`);
  expect(plist).toContain("<key>UserName</key>\n  <string>me</string>");
  expect(plist).toContain("<key>GroupName</key>\n  <string>staff</string>");
  expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  expect(plist).toContain(
    "<key>StandardOutPath</key>\n  <string>/rig/daemon/startup.log</string>",
  );
  expect(plist).toContain("<key>RIG_DAEMON_MODE</key><string>system</string>");
  expect(() =>
    rigdSystemPlist({
      root: "/rig",
      command: ["/rig/bin/rigd"],
      userHome: "/var/root",
      userName: "root",
    }),
  ).toThrow(expect.objectContaining({ code: "LAUNCHD_ROOT" }));
});

test("only a job program outside <root>/bin/rigd is warned about", () => {
  expect(unstableProgramWarning("/rig", ["/rig/bin/rigd", "serve"])).toEqual(
    [],
  );
  expect(unstableProgramWarning("/rig", ["/opt/rigd"])).toEqual([
    "The rigd system job runs /opt/rigd, not /rig/bin/rigd; installing a rigd from another path asks for sudo again.",
  ]);
});

const job = (label: string): SystemJob => ({
  label,
  plist: `<plist>${label}</plist>`,
  source: `/rig/daemon/launchd/${label}.plist`,
});
test("a boot install that needs sudo lists the stale Caddy's removal first, then one install line per job", () => {
  const error = systemInstallRequired({
    pending: [job("caddy"), job("rigd")],
    staleCaddy: "old-caddy",
    userName: "me",
    places,
  });
  const lines = [
    systemRemoveLine("old-caddy", places),
    systemInstallLine(job("caddy"), places),
    systemInstallLine(job("rigd"), places),
  ];
  expect(error).toMatchObject({
    code: "DAEMON_SYSTEM_INSTALL",
    message:
      "caddy and rigd must be installed as system jobs that run as me from boot, which needs sudo once.",
    hint: `Paste each of these lines in a terminal, then run rigd install again. Each line stops at the first failure, and checks a plist's digest before anything is installed:\n${lines.join("\n")}`,
    details: { commands: lines },
  });
  expect(
    systemInstallRequired({ pending: [job("rigd")], userName: "me", places })
      .message,
  ).toBe(
    "rigd must be installed as system job that run as me from boot, which needs sudo once.",
  );
  const stale = systemInstallRequired({
    pending: [],
    staleCaddy: "old-caddy",
    userName: "me",
    places,
  });
  expect(stale.message).toBe(
    "Rig's Caddy is still installed as the system job old-caddy, but Host config has no proxy section.",
  );
  expect(stale.hint).toStartWith("Paste this line in a terminal");
});

test("system jobs left behind refuse a login install and an uninstall, each with its removal lines", () => {
  expect(systemJobsRemain(["a"], places)).toMatchObject({
    code: "DAEMON_SYSTEM_INSTALL",
    message:
      "rigd is still installed as a system job (a), but Host config asks for daemon.start: login.",
    hint: `Paste this line in a terminal, then run rigd install again:\n${systemRemoveLine("a", places)}`,
    details: { labels: ["a"] },
  });
  expect(systemJobsRemain(["a", "b"], places).message).toBe(
    "rigd is still installed as a system job (a, b), but Host config asks for daemon.start: login.",
  );
  const lines = [systemRemoveLine("a", places), systemRemoveLine("b", places)];
  expect(systemRemovalRequired(["a", "b"], places)).toMatchObject({
    code: "DAEMON_SYSTEM_UNINSTALL",
    message: "a and b are system jobs, which only root can remove.",
    hint: `Removing rigd's job stops rigd, so stop every Target first (rig down). Then paste each of these lines in a terminal, and run the same rigd command again:\n${lines.join("\n")}`,
    details: { commands: lines },
  });
  expect(systemRemovalRequired(["a"], places).message).toBe(
    "a is a system job, which only root can remove.",
  );
});
