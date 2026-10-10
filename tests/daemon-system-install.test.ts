import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonAdmin } from "../src/daemon/admin";
import { readInstallationRecord } from "../src/daemon/installation";
import { processExists } from "../src/daemon/host";
import { writeStartupFailure } from "../src/daemon/startup-failure";

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
  let keepAlive = false;
  const stopDaemon = async () => {
    keepAlive = false;
    daemon?.kill();
    await daemon?.exited;
  };
  cleanups.push(async () => {
    await stopDaemon();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    places,
    admin,
    calls,
    launchd,
    /** What launchd does once the owner's line ran: start the program in the plist, and start it again whenever it exits
     * (KeepAlive). */
    async startAsLaunchd() {
      keepAlive = true;
      void (async () => {
        while (keepAlive) {
          daemon = Bun.spawn([process.execPath, script], {
            env: {
              ...process.env,
              RIG_ROOT: root,
              RIG_DAEMON_CHILD: "1",
              RIG_DAEMON_MODE: "system",
            },
            stdout: "ignore",
            stderr: "ignore",
          });
          await daemon.exited;
          await Bun.sleep(100);
        }
      })();
      for (let i = 0; i < 100 && !(await admin.status()).reachable; i++)
        await Bun.sleep(50);
      return daemon!.pid;
    },
    stopDaemon,
    /** The owner's pasted lines, as far as this root can tell: the rendered plists installed and loaded. */
    async paste(labels: readonly string[]) {
      for (const label of labels)
        await writeFile(
          join(places.daemons, `${label}.plist`),
          await readFile(
            join(root, "daemon", "launchd", `${label}.plist`),
            "utf8",
          ),
        );
      launchd.loaded = true;
    },
  };
}
const labelOf = (line: string) =>
  line.match(
    /bootstrap system '.*\/(com\.b-relay\.[a-z-]+\.[0-9a-f]+)\.plist'/,
  )![1]!;

test("a first boot install prepares everything that needs no root and prints one gated sudo line, loading nothing itself", async () => {
  const w = await world();
  const error = await w.admin.install().catch((caught) => caught);
  expect(error).toMatchObject({ code: "DAEMON_SYSTEM_INSTALL" });
  const [line] = error.details.commands as string[];
  const label = line!.match(
    /bootstrap system '.*\/(com\.b-relay\.rigd\.[0-9a-f]+)\.plist'/,
  )![1]!;
  expect(error.hint).toContain(line);
  // The line stages a copy root writes from what the user's shell reads, checks its digest (deleting it on a mismatch), then
  // removes the LaunchAgent, installs and bootstraps, in that order.
  expect(line).toMatch(
    /sudo sh -c '.*' < '.*' && \{ echo '[0-9a-f]{64} {2}.*' \| sudo shasum -a 256 -c - \|\| \{ sudo rm -f .*; false; \}; \} && \{ ! launchctl print gui\/502\/.* && rm -f .* && sudo install .* && \{ ! sudo launchctl print system\/.* && sudo launchctl enable system\/.* && sudo launchctl bootstrap system /,
  );
  const plist = await readFile(
    join(w.root, "daemon", "launchd", `${label}.plist`),
    "utf8",
  );
  expect(plist).toContain("<key>UserName</key>\n  <string>clay</string>");
  expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  // The environment is fixed, not the installing shell's.
  expect(plist).not.toContain(process.env.PATH ?? "unset");
  // Until the job is installed, the record does not claim it: a line never pasted leaves nothing recorded wrongly.
  expect(await readInstallationRecord(w.root)).toMatchObject({
    mode: "launchd",
  });
  expect(plist).toContain("<key>RIG_DAEMON_MODE</key><string>system</string>");
  // Only launchd's state was read: nothing was booted out or bootstrapped.
  expect(w.calls.every((call) => call.startsWith("print "))).toBe(true);
  // Rendering again gives the same plist, so a repeated install asks for nothing new.
  await w.admin.install().catch(() => {});
  expect(
    await readFile(join(w.root, "daemon", "launchd", `${label}.plist`), "utf8"),
  ).toBe(plist);
});

test("once the owner's line installed the job, the next install restarts rigd through launchd and records it; then nothing changes", async () => {
  const w = await world();
  const error = await w.admin.install().catch((caught) => caught);
  await w.paste((error.details.commands as string[]).map(labelOf));
  const first = await w.startAsLaunchd();
  // A failure an earlier start recorded is not this one's.
  await writeStartupFailure(w.root, new Error("an old start failed"));
  expect(await w.admin.install()).toMatchObject({
    outcome: "installed",
    replaced: { pid: first },
    reachable: true,
  });
  expect(await readInstallationRecord(w.root)).toMatchObject({
    mode: "system",
  });
  expect(await w.admin.install()).toMatchObject({
    outcome: "unchanged",
    reachable: true,
  });
}, 60_000);

test("a system Caddy left from a removed proxy section is named with its removal line, even when rigd's job is installed", async () => {
  const w = await world();
  const error = await w.admin.install().catch((caught) => caught);
  await w.paste((error.details.commands as string[]).map(labelOf));
  const caddyLabel = labelOf(error.details.commands[0]).replace(
    "rigd",
    "rig-caddy",
  );
  await writeFile(join(w.places.daemons, `${caddyLabel}.plist`), "left");
  const stale = await w.admin.install().catch((caught) => caught);
  expect(stale).toMatchObject({ code: "DAEMON_SYSTEM_INSTALL" });
  expect(stale.details.commands).toEqual([
    expect.stringContaining(`bootout system/${caddyLabel}`),
  ]);
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
