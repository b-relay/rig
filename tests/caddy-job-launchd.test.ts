import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("removing the login job deletes its plist only once launchd confirms it gone; a refused or unobservable stop fails closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "rig-launchd-remove-"));
  try {
    const plist = join(home, "Library", "LaunchAgents");
    await mkdir(plist, { recursive: true });
    const remover = (print: () => { code: number; stdout: string }) => {
      const calls: string[] = [];
      const job = createLaunchAgentCaddyJob({
        root,
        paths,
        userHome: home,
        uid: 502,
        admin,
        deadlineMs: 300,
        launchctl: async (args) => {
          calls.push(args[0]!);
          return args[0] === "print"
            ? { ...print(), stderr: "" }
            : {
                code: 5,
                stdout: "",
                stderr: "Boot-out failed: 5: Input/output error",
              };
        },
      });
      return {
        job,
        calls,
        file: join(plist, `${job.description.split("/").at(-1)}`),
      };
    };
    // launchd refuses the stop: the job still runs, so the plist stays and remove fails.
    const refused = remover(() => ({
      code: 0,
      stdout: "\tstate = running\n\tpid = 4242\n",
    }));
    await writeFile(refused.file, "plist");
    await expect(refused.job.remove()).rejects.toMatchObject({
      code: "LAUNCHD",
      details: { state: "running" },
    });
    expect(await stat(refused.file).catch(() => undefined)).toBeDefined();
    // launchd cannot say (print exits 64): not proof of absence either.
    const blind = remover(() => ({
      code: 64,
      stdout: "Could not find service",
    }));
    await expect(blind.job.remove()).rejects.toMatchObject({ code: "LAUNCHD" });
    expect(await stat(blind.file).catch(() => undefined)).toBeDefined();
    // The bootout takes: print exits 113, and only then is the plist removed.
    let booted = false;
    const taken = remover(() =>
      booted
        ? { code: 113, stdout: "" }
        : { code: 0, stdout: "\tstate = running\n\tpid = 4242\n" },
    );
    await writeFile(taken.file, "plist");
    setTimeout(() => {
      booted = true;
    }, 100);
    await taken.job.remove();
    expect(await stat(taken.file).catch(() => undefined)).toBeUndefined();
    expect(taken.calls).toContain("bootout");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

/** launchd as it treats one login job: a bootout answers at once while the old process drains for `drainMs`, its label
 * staying loaded until then, and a bootstrap of a label still loaded fails with 5. `drainMs` undefined never drains. */
function drainingLaunchd(drainMs: number | undefined) {
  const calls: string[] = [];
  let loaded = true;
  let drained: number | undefined;
  const launchctl: LaunchctlCommand = async (args) => {
    calls.push(args[0]!);
    if (drained !== undefined && Date.now() >= drained) loaded = false;
    if (args[0] === "print")
      return loaded
        ? {
            code: 0,
            stdout: `\tstate = ${drained === undefined ? "running" : "SIGTERMed"}\n\tpid = 4242\n`,
            stderr: "",
          }
        : { code: 113, stdout: "", stderr: "Could not find service" };
    if (args[0] === "bootout") {
      drained = Date.now() + (drainMs ?? Number.POSITIVE_INFINITY);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (loaded)
      return {
        code: 5,
        stdout: "",
        stderr: "Bootstrap failed: 5: Input/output error",
      };
    loaded = true;
    drained = undefined;
    return { code: 0, stdout: "", stderr: "" };
  };
  return { launchctl, calls };
}
const answering = {
  reachable: async () => true,
  config: async () => ({}),
  load: async () => undefined,
  stop: async () => true,
};

test("replacing the login job's definition bootstraps it only once launchd has let the old job's label go", async () => {
  const home = await mkdtemp(join(tmpdir(), "rig-launchd-replace-"));
  try {
    const launchd = drainingLaunchd(300);
    const job = createLaunchAgentCaddyJob({
      root,
      paths,
      userHome: home,
      uid: 502,
      admin: answering,
      deadlineMs: 2_000,
      launchctl: launchd.launchctl,
    });
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(job.description, "<!-- an older definition -->");
    expect(await job.install()).toEqual({ changed: true });
    expect(await job.matches()).toBe(true);
    // Bootstrapped once, after launchd said the old label was gone (print's 113), never while it drained.
    expect(launchd.calls.filter((call) => call === "bootstrap")).toHaveLength(
      1,
    );
    expect(launchd.calls.at(-1)).toBe("bootstrap");
    expect(launchd.calls.indexOf("bootout")).toBeLessThan(
      launchd.calls.lastIndexOf("print"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a login job that does not let its label go is not replaced: the install fails and the old definition stays for the next one", async () => {
  const home = await mkdtemp(join(tmpdir(), "rig-launchd-replace-"));
  try {
    const launchd = drainingLaunchd(undefined);
    const job = createLaunchAgentCaddyJob({
      root,
      paths,
      userHome: home,
      uid: 502,
      admin: answering,
      deadlineMs: 300,
      launchctl: launchd.launchctl,
    });
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(job.description, "<!-- an older definition -->");
    await expect(job.install()).rejects.toMatchObject({
      code: "LAUNCHD",
      message: expect.stringContaining("is still loaded"),
    });
    expect(launchd.calls).not.toContain("bootstrap");
    expect(await readFile(job.description, "utf8")).toBe(
      "<!-- an older definition -->",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
