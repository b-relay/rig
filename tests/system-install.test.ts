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
/** A shell where sudo runs its command as is, install copies without changing owners, and launchctl only logs: the chain's
 * gating is exercised for real, while nothing reaches the real launchd or /Library. */
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "rig-system-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const log = join(root, "launchctl.log");
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
    launchctl: `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`,
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
    launchctl: () => readFile(log, "utf8").catch(() => ""),
  };
}
const plist = renderLaunchdPlist({
  label: "com.b-relay.rig-caddy.test",
  programArguments: ["/r/caddy/bin/caddy", "run"],
  environment: { HOME: "/Users/clay" },
  workingDirectory: "/r",
  log: "/r/caddy/launchd.log",
  keepAlive: "always",
  userName: "clay",
  groupName: "staff",
});

test("the install line copies, verifies, removes the LaunchAgent it replaces, installs and bootstraps, in that order", async () => {
  const s = await sandbox();
  const source = join(s.root, "rendered.plist");
  await writeFile(source, plist);
  const agent = join(s.root, "agent.plist");
  await writeFile(agent, "old agent");
  const line = systemInstallLine(
    {
      label: "com.b-relay.rig-caddy.test",
      plist,
      source,
      replaces: { domain: "gui/502", plist: agent },
    },
    s.places,
  );
  expect((await s.run(line)).code).toBe(0);
  expect(
    await readFile(
      join(s.places.daemons, "com.b-relay.rig-caddy.test.plist"),
      "utf8",
    ),
  ).toBe(plist);
  expect(existsSync(agent)).toBe(false);
  expect(await s.launchctl()).toBe(
    [
      "bootout gui/502/com.b-relay.rig-caddy.test",
      "bootout system/com.b-relay.rig-caddy.test",
      `bootstrap system ${join(s.places.daemons, "com.b-relay.rig-caddy.test.plist")}`,
      "",
    ].join("\n"),
  );
}, 30_000);

test("a plist changed after Rig rendered it fails the check: nothing reaches LaunchDaemons or launchd, and the LaunchAgent stays", async () => {
  const s = await sandbox();
  const source = join(s.root, "rendered.plist");
  // Rendered, printed, then swapped for one that would run as root.
  await writeFile(
    source,
    plist.replace("<string>clay</string>", "<string>root</string>"),
  );
  const agent = join(s.root, "agent.plist");
  await writeFile(agent, "old agent");
  const line = systemInstallLine(
    {
      label: "com.b-relay.rig-caddy.test",
      plist,
      source,
      replaces: { domain: "gui/502", plist: agent },
    },
    s.places,
  );
  expect((await s.run(line)).code).not.toBe(0);
  expect(
    existsSync(join(s.places.daemons, "com.b-relay.rig-caddy.test.plist")),
  ).toBe(false);
  expect(existsSync(agent)).toBe(true);
  // The staged copy that failed its check is deleted, not left behind.
  expect(
    existsSync(join(s.places.staging, "com.b-relay.rig-caddy.test.plist")),
  ).toBe(false);
  expect(await s.launchctl()).toBe("");
}, 30_000);

test("the remove line stops the system job and deletes both of its plists", async () => {
  const s = await sandbox();
  const label = "com.b-relay.rig-caddy.test";
  await mkdir(s.places.staging, { recursive: true });
  await writeFile(join(s.places.daemons, `${label}.plist`), plist);
  await writeFile(join(s.places.staging, `${label}.plist`), plist);
  expect((await s.run(systemRemoveLine(label, s.places))).code).toBe(0);
  expect(existsSync(join(s.places.daemons, `${label}.plist`))).toBe(false);
  expect(existsSync(join(s.places.staging, `${label}.plist`))).toBe(false);
  expect(await s.launchctl()).toBe(`bootout system/${label}\n`);
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
