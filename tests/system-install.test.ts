import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  systemInstallLine,
  systemRemoveLine,
  type SystemPlaces,
} from "../src/domain/system-install";
import { renderLaunchdPlist } from "../src/domain/launchd-plist";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
/** A shell where sudo runs its command as is, install copies without changing owners, and launchctl keeps which jobs are
 * loaded in a file, as launchd would: the lines' gating is exercised for real, while nothing reaches the real launchd or
 * /Library. `bootoutFails` makes a bootout fail; `bootoutSticks` makes it report success yet leave the job loaded. */
async function sandbox(loaded: readonly string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "rig-system-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const log = join(root, "launchctl.log");
  const state = join(root, "loaded");
  await writeFile(state, loaded.map((target) => `${target}\n`).join(""));
  const stubs: Record<string, string> = {
    sudo: '#!/bin/sh\nexec "$@"\n',
    install: [
      "#!/bin/sh",
      'dir=""; files=""',
      'while [ "$#" -gt 0 ]; do case "$1" in -d) dir=1;; -m|-o|-g) shift;; *) files="$files$1\n";; esac; shift; done',
      'if [ -n "$dir" ]; then printf "$files" | while IFS= read -r f; do [ -n "$f" ] && mkdir -p "$f"; done; exit 0; fi',
      'src=$(printf "$files" | sed -n 1p); dst=$(printf "$files" | sed -n 2p)',
      '[ -d "$dst" ] && dst="$dst/$(basename "$src")"',
      'cp "$src" "$dst"',
      "",
    ].join("\n"),
    launchctl: [
      "#!/bin/sh",
      `log=${JSON.stringify(log)}; state=${JSON.stringify(state)}`,
      'echo "$@" >> "$log"',
      'case "$1" in',
      '  print) grep -qx "$2" "$state";;',
      `  bootout) [ -e ${JSON.stringify(join(root, "bootoutFails"))} ] && exit 5`,
      `    [ -e ${JSON.stringify(join(root, "bootoutSticks"))} ] && exit 0`,
      '    grep -vx "$2" "$state" > "$state.tmp"; mv "$state.tmp" "$state"',
      `    [ -e ${JSON.stringify(join(root, "bootoutInProgress"))} ] && exit 36; exit 0;;`,
      '  bootstrap) echo "system/$(basename "$3" .plist)" >> "$state";;',
      "esac",
      "",
    ].join("\n"),
    sleep: "#!/bin/sh\nexit 0\n",
  };
  for (const [name, text] of Object.entries(stubs)) {
    await writeFile(join(bin, name), text);
    await chmod(join(bin, name), 0o755);
  }
  const places: SystemPlaces = {
    staging: join(root, "Application Support", "Rig"),
    daemons: join(root, "LaunchDaemons"),
  };
  await mkdir(places.daemons);
  return {
    root,
    places,
    async run(line: string) {
      const child = Bun.spawn(["/bin/sh", "-c", line], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: await child.exited };
    },
    /** Every launchctl call but the reads. */
    launchctl: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line && !line.startsWith("print ")),
    loaded: async () =>
      (await readFile(state, "utf8")).split("\n").filter(Boolean),
    fail: (how: "bootoutFails" | "bootoutSticks" | "bootoutInProgress") =>
      writeFile(join(root, how), ""),
  };
}
const label = "com.b-relay.rig-caddy.test";
const plist = renderLaunchdPlist({
  label,
  programArguments: ["/r/caddy/bin/caddy", "run"],
  environment: { HOME: "/Users/clay" },
  workingDirectory: "/r",
  log: "/r/caddy/launchd.log",
  keepAlive: "always",
  userName: "clay",
  groupName: "staff",
});
async function installLine(
  s: Awaited<ReturnType<typeof sandbox>>,
  source = plist,
) {
  const file = join(s.root, "rendered.plist");
  await writeFile(file, source);
  const agent = join(s.root, "agent.plist");
  await writeFile(agent, "old agent");
  return {
    agent,
    line: systemInstallLine(
      {
        label,
        plist,
        source: file,
        replaces: { domain: "gui/502", plist: agent },
      },
      s.places,
    ),
  };
}

test("the install line copies, verifies, stops the LaunchAgent it replaces, installs, enables and bootstraps, in that order", async () => {
  const s = await sandbox([`gui/502/${label}`]);
  const { line, agent } = await installLine(s);
  expect((await s.run(line)).code).toBe(0);
  expect(await readFile(join(s.places.daemons, `${label}.plist`), "utf8")).toBe(
    plist,
  );
  expect(existsSync(agent)).toBe(false);
  expect(await s.launchctl()).toEqual([
    `bootout gui/502/${label}`,
    `enable system/${label}`,
    `bootstrap system ${join(s.places.daemons, `${label}.plist`)}`,
  ]);
  expect(await s.loaded()).toEqual([`system/${label}`]);
}, 30_000);

test("a loaded system job is stopped before it is installed again, and only a confirmed stop lets the line go on", async () => {
  const s = await sandbox([`system/${label}`]);
  const { line } = await installLine(s);
  expect((await s.run(line)).code).toBe(0);
  expect(await s.launchctl()).toEqual([
    `bootout system/${label}`,
    `enable system/${label}`,
    `bootstrap system ${join(s.places.daemons, `${label}.plist`)}`,
  ]);

  // A bootout that reports "operation in progress" while the job does stop is a stop, not a failure.
  const draining = await sandbox([`system/${label}`]);
  await draining.fail("bootoutInProgress");
  const { line: drained } = await installLine(draining);
  expect((await draining.run(drained)).code).toBe(0);
  expect(await draining.loaded()).toEqual([`system/${label}`]);

  for (const how of ["bootoutFails", "bootoutSticks"] as const) {
    const stuck = await sandbox([`gui/502/${label}`]);
    await stuck.fail(how);
    const { line: again, agent } = await installLine(stuck);
    expect((await stuck.run(again)).code).not.toBe(0);
    // The LaunchAgent would not stop: nothing was installed or loaded, and it stays.
    expect(existsSync(join(stuck.places.daemons, `${label}.plist`))).toBe(
      false,
    );
    expect(existsSync(agent)).toBe(true);
    expect(await stuck.launchctl()).toEqual([`bootout gui/502/${label}`]);
  }
}, 30_000);

test("a plist changed after Rig rendered it fails the check: nothing reaches LaunchDaemons or launchd, and the LaunchAgent stays", async () => {
  const s = await sandbox([`gui/502/${label}`]);
  // Rendered, printed, then swapped for one that would run as root.
  const { line, agent } = await installLine(
    s,
    plist.replace("<string>clay</string>", "<string>root</string>"),
  );
  expect((await s.run(line)).code).not.toBe(0);
  expect(existsSync(join(s.places.daemons, `${label}.plist`))).toBe(false);
  expect(existsSync(agent)).toBe(true);
  // The staged copy that failed its check is deleted, not left behind.
  expect(existsSync(join(s.places.staging, `${label}.plist`))).toBe(false);
  expect(await s.launchctl()).toEqual([]);
}, 30_000);

test("the remove line stops the system job and deletes both of its plists; a stop that fails deletes nothing", async () => {
  const s = await sandbox([`system/${label}`]);
  await mkdir(s.places.staging, { recursive: true });
  await writeFile(join(s.places.daemons, `${label}.plist`), plist);
  await writeFile(join(s.places.staging, `${label}.plist`), plist);
  expect((await s.run(systemRemoveLine(label, s.places))).code).toBe(0);
  expect(existsSync(join(s.places.daemons, `${label}.plist`))).toBe(false);
  expect(existsSync(join(s.places.staging, `${label}.plist`))).toBe(false);
  expect(await s.launchctl()).toEqual([`bootout system/${label}`]);
  // Already gone: removing again is fine.
  expect((await s.run(systemRemoveLine(label, s.places))).code).toBe(0);

  const stuck = await sandbox([`system/${label}`]);
  await stuck.fail("bootoutSticks");
  await writeFile(join(stuck.places.daemons, `${label}.plist`), plist);
  expect(
    (await stuck.run(systemRemoveLine(label, stuck.places))).code,
  ).not.toBe(0);
  expect(existsSync(join(stuck.places.daemons, `${label}.plist`))).toBe(true);
}, 30_000);

test("Rig never renders a plist that runs as root", () => {
  expect(() =>
    renderLaunchdPlist({
      label: "x",
      programArguments: ["/bin/true"],
      environment: {},
      workingDirectory: "/",
      log: "/tmp/x.log",
      keepAlive: "always",
      userName: "root",
    }),
  ).toThrow(expect.objectContaining({ code: "LAUNCHD_ROOT" }));
  // An empty name would drop UserName, which runs the job as root too.
  expect(() =>
    renderLaunchdPlist({
      label: "x",
      programArguments: ["/bin/true"],
      environment: {},
      workingDirectory: "/",
      log: "/tmp/x.log",
      keepAlive: "always",
      userName: "",
    }),
  ).toThrow(expect.objectContaining({ code: "LAUNCHD_ROOT" }));
});
