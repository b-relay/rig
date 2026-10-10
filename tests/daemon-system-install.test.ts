import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonAdmin } from "../src/daemon/admin";
import { readInstallationRecord } from "../src/daemon/installation";
import { processExists } from "../src/daemon/host";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => {});
});
/** A Rig root asking for `daemon.start: boot`, with launchd faked: `print` answers as `loaded` says, and every call is
 * recorded. System plists go to temporary directories, never /Library. */
async function world() {
  const root = await mkdtemp(join(tmpdir(), "rig-boot-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const script = join(root, "child.ts");
  const hostModule = join(import.meta.dir, "../src/daemon/host.ts");
  await writeFile(
    script,
    `import { runDaemonHost } from ${JSON.stringify(hostModule)}; await runDaemonHost({root:process.env.RIG_ROOT!,handle:async()=>({ready:true}),shutdown:async()=>{},port:0});`,
  );
  const places = {
    staging: join(root, "staging"),
    daemons: join(root, "LaunchDaemons"),
  };
  await mkdir(places.daemons, { recursive: true });
  const calls: string[] = [];
  const launchd = { loaded: false };
  const admin = new DaemonAdmin({
    root,
    command: [process.execPath, script],
    mode: "launchd",
    userHome: home,
    uid: 502,
    userName: "clay",
    start: async () => "boot",
    systemPlaces: places,
    launchctl: async (args) => {
      calls.push(args.join(" "));
      return args[0] === "print" && launchd.loaded
        ? { code: 0, stderr: "" }
        : args[0] === "print"
          ? { code: 113, stderr: "Could not find service" }
          : { code: 0, stderr: "" };
    },
  });
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  cleanups.push(async () => {
    daemon?.kill();
    await daemon?.exited;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    places,
    admin,
    calls,
    launchd,
    /** What launchd would do once the owner's line ran: start the program in the plist. */
    async startAsLaunchd() {
      daemon = Bun.spawn([process.execPath, script], {
        env: { ...process.env, RIG_ROOT: root, RIG_DAEMON_CHILD: "1" },
        stdout: "ignore",
        stderr: "ignore",
      });
      for (let i = 0; i < 100 && !(await admin.status()).reachable; i++)
        await Bun.sleep(50);
      return daemon.pid;
    },
    stopDaemon: async () => {
      daemon?.kill();
      await daemon?.exited;
    },
  };
}

test("a first boot install prepares everything that needs no root and prints one gated sudo line, loading nothing itself", async () => {
  const w = await world();
  const error = await w.admin.install().catch((caught) => caught);
  expect(error).toMatchObject({ code: "DAEMON_SYSTEM_INSTALL" });
  const [line] = error.details.commands as string[];
  const label = line!.match(
    /bootstrap system '.*\/(com\.b-relay\.rigd\.[0-9a-f]+)\.plist'/,
  )![1]!;
  expect(error.hint).toContain(line);
  // The line copies, checks the digest, removes the LaunchAgent, installs and bootstraps, in that order.
  expect(line).toMatch(
    /install -m 644 -o root -g wheel .* && echo '[0-9a-f]{64} {2}.*' \| sudo shasum -a 256 -c - && \{ launchctl bootout gui\/502\/.* && sudo install .* && .* && sudo launchctl bootstrap system /,
  );
  const plist = await readFile(
    join(w.root, "daemon", "launchd", `${label}.plist`),
    "utf8",
  );
  expect(plist).toContain("<key>UserName</key>\n  <string>clay</string>");
  expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  // The environment is fixed, not the installing shell's.
  expect(plist).not.toContain(process.env.PATH ?? "unset");
  expect(await readInstallationRecord(w.root)).toMatchObject({
    mode: "system",
  });
  // Only launchd's state was read: nothing was booted out or bootstrapped.
  expect(w.calls.every((call) => call.startsWith("print "))).toBe(true);
  // Rendering again gives the same plist, so a repeated install asks for nothing new.
  await w.admin.install().catch(() => {});
  expect(
    await readFile(join(w.root, "daemon", "launchd", `${label}.plist`), "utf8"),
  ).toBe(plist);
});

test("once the owner's line installed the job, an install with the same build changes nothing and needs no sudo", async () => {
  const w = await world();
  const error = await w.admin.install().catch((caught) => caught);
  const label = (error.details.commands[0] as string).match(
    /(com\.b-relay\.rigd\.[0-9a-f]+)\.plist'$/,
  )![1]!;
  // What the owner's line leaves behind: the rendered plist in LaunchDaemons, loaded, and launchd running rigd.
  await writeFile(
    join(w.places.daemons, `${label}.plist`),
    await readFile(join(w.root, "daemon", "launchd", `${label}.plist`), "utf8"),
  );
  w.launchd.loaded = true;
  await w.startAsLaunchd();
  expect(await w.admin.install()).toMatchObject({
    outcome: "unchanged",
    reachable: true,
  });
});

test("going back to login with the system job still installed prints the removal instead of starting a second rigd", async () => {
  const w = await world();
  const error = await w.admin.install().catch((caught) => caught);
  const label = (error.details.commands[0] as string).match(
    /(com\.b-relay\.rigd\.[0-9a-f]+)\.plist'$/,
  )![1]!;
  await writeFile(join(w.places.daemons, `${label}.plist`), "installed");
  const login = new DaemonAdmin({
    root: w.root,
    command: [process.execPath, "unused"],
    mode: "launchd",
    userHome: join(w.root, "home"),
    uid: 502,
    userName: "clay",
    start: async () => "login",
    systemPlaces: w.places,
    launchctl: async () => ({ code: 0, stderr: "" }),
  });
  const refused = await login.install().catch((caught) => caught);
  expect(refused).toMatchObject({ code: "DAEMON_SYSTEM_INSTALL" });
  expect(refused.hint).toContain(`sudo launchctl bootout system/${label}`);
  expect(refused.hint).toContain(`sudo rm -f`);
});

test("uninstall of a system job prints the removal and keeps rigd serving; once removed, uninstall finishes", async () => {
  const w = await world();
  const error = await w.admin.install().catch((caught) => caught);
  const label = (error.details.commands[0] as string).match(
    /(com\.b-relay\.rigd\.[0-9a-f]+)\.plist'$/,
  )![1]!;
  const installed = join(w.places.daemons, `${label}.plist`);
  await writeFile(
    installed,
    await readFile(join(w.root, "daemon", "launchd", `${label}.plist`), "utf8"),
  );
  w.launchd.loaded = true;
  const pid = await w.startAsLaunchd();
  const refused = await w.admin.uninstall().catch((caught) => caught);
  expect(refused).toMatchObject({ code: "DAEMON_SYSTEM_UNINSTALL" });
  expect(refused.details.commands[0]).toContain(`bootout system/${label}`);
  // Not left draining: rigd still serves until the owner removes the job.
  expect(await w.admin.status()).toMatchObject({ reachable: true });
  expect(processExists(pid)).toBe(true);

  // The owner's line: launchd stops rigd and both plists are gone.
  await w.stopDaemon();
  await rm(installed);
  w.launchd.loaded = false;
  expect(await w.admin.uninstall()).toMatchObject({ outcome: "uninstalled" });
  expect(await readInstallationRecord(w.root)).toBeUndefined();
});
