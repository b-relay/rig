import { expect, test } from "bun:test";
import {
  launchAgentPlist,
  launchctlFailure,
  rigdJobLabel,
} from "../src/daemon/admin-launch-agent";
import { daemonEnvironment } from "../src/daemon/environment";

test("the LaunchAgent plist is one line, every value escaped, restarted only after an unsuccessful exit", () => {
  expect(
    launchAgentPlist({
      label: "com.b-relay.rigd.abc",
      command: ["/rig/bin/rigd", "a&b"],
      environment: { PATH: "/usr/bin", NOTE: '<"q">' },
      root: "/rig",
    }),
  ).toBe(
    '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.b-relay.rigd.abc</string>' +
      "<key>ProgramArguments</key><array><string>/rig/bin/rigd</string><string>a&amp;b</string></array>" +
      "<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string><key>NOTE</key><string>&lt;&quot;q&quot;&gt;</string></dict>" +
      "<key>WorkingDirectory</key><string>/rig</string><key>RunAtLoad</key><true/>" +
      "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer>" +
      "<key>StandardOutPath</key><string>/rig/daemon/startup.log</string><key>StandardErrorPath</key><string>/rig/daemon/startup.log</string></dict></plist>",
  );
});

test("rigd's job label is fixed per root", () => {
  expect(rigdJobLabel("/rig")).toBe(rigdJobLabel("/rig"));
  expect(rigdJobLabel("/rig")).toMatch(/^com\.b-relay\.rigd\.[0-9a-f]+$/);
  expect(rigdJobLabel("/other")).not.toBe(rigdJobLabel("/rig"));
});

test("a launchctl failure names stderr's last line, or nothing when stderr is empty", () => {
  const failure = launchctlFailure({
    code: 5,
    stderr: "Boot-out failed: 5\nInput/output error\n\n",
  });
  expect(failure).toMatchObject({
    code: "LAUNCHD",
    message: "Unable to administer the rigd launchd job: Input/output error",
    hint: "Inspect daemon installation and retry.",
    details: { code: 5, stderr: "Boot-out failed: 5\nInput/output error\n\n" },
  });
  expect(launchctlFailure({ code: 1, stderr: " " }).message).toBe(
    "Unable to administer the rigd launchd job.",
  );
});

test("rigd starts with a fixed PATH unless the shell has one, the shell's login basics, and its own variables last", () => {
  expect(daemonEnvironment("/rig", {})).toEqual({
    PATH: "/usr/bin:/bin",
    RIG_ROOT: "/rig",
    RIG_DAEMON_CHILD: "1",
  });
  const environment = daemonEnvironment("/rig", {
    PATH: "/opt/bin",
    HOME: "/Users/me",
    RIG_ROOT: "/elsewhere",
    SECRET_TOKEN: "x",
  });
  expect(environment).toEqual({
    PATH: "/opt/bin",
    HOME: "/Users/me",
    RIG_ROOT: "/rig",
    RIG_DAEMON_CHILD: "1",
  });
  expect(Object.keys(environment)).toEqual([
    "PATH",
    "HOME",
    "RIG_ROOT",
    "RIG_DAEMON_CHILD",
  ]);
});
