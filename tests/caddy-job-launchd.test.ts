import { expect, test } from "bun:test";
import { proxyPaths } from "../src/domain/managed-proxy";
import { createCaddyAdmin } from "../src/providers/caddy-admin";
import {
  createLaunchAgentCaddyJob,
  createSystemCaddyJob,
  type LaunchctlCommand,
} from "../src/providers/caddy-job";

const root = "/tmp/rig-launchd-state";
const paths = proxyPaths(root);
const admin = createCaddyAdmin(paths.socket, 50);
const printing =
  (code: number, stdout: string, stderr: string): LaunchctlCommand =>
  async () => ({ code, stdout, stderr });
const jobs = (launchctl: LaunchctlCommand) => [
  createLaunchAgentCaddyJob({
    root,
    paths,
    userHome: "/tmp/rig-launchd-home",
    uid: 502,
    admin,
    launchctl,
  }),
  createSystemCaddyJob({
    root,
    paths,
    userHome: "/tmp/rig-launchd-home",
    userName: "clay",
    admin,
    launchctl,
  }),
];

test("only launchctl's exit 113 confirms a job stopped; its words on any other exit leave the state unknown", async () => {
  for (const job of jobs(
    printing(113, "", 'Could not find service "x" in domain for user gui: 502'),
  ))
    expect(await job.state()).toBe("stopped");
  for (const job of jobs(
    printing(64, "Could not find service", "Could not find service"),
  ))
    expect(await job.state()).toBe("unknown");
  for (const job of jobs(printing(5, "", "Bootstrap failed: 5: Input/output")))
    expect(await job.state()).toBe("unknown");
  for (const job of jobs(printing(0, "\tstate = running\n\tpid = 4242\n", "")))
    expect(await job.state()).toBe("running");
});
