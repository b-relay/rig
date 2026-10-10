import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
/** The ADR's runbook functions and cutover line, exactly as written there. */
async function runbook(): Promise<{ functions: string; cutover: string }> {
  const adr = await readFile(
    join(import.meta.dir, "../docs/adr/0014-rig-owned-caddy.md"),
    "utf8",
  );
  const blocks = [...adr.matchAll(/```sh\n([\s\S]*?)```/g)]
    .map((match) => match[1]!)
    // The ADR indents its code blocks inside list items.
    .map((block) => block.replace(/^ {3}/gm, ""));
  const functions = blocks.find((block) => block.includes("rollback()"))!;
  const cutover = blocks.find((block) => block.includes("CUT OVER"))!;
  return { functions, cutover };
}
/** A shell where sudo runs its command, launchctl keeps loaded and disabled jobs in files, and caddy and curl are stand-ins.
 * Absolute paths to the real Caddy are pointed at the stand-in, so nothing reaches launchd, the router or the network. */
async function sandbox(options: {
  loaded: string[];
  /** Labels whose bootout fails. */
  stuck?: string[];
  /** Labels whose bootstrap fails. */
  refused?: string[];
}) {
  const root = await mkdtemp(join(tmpdir(), "rig-runbook-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const loaded = join(root, "loaded");
  const disabled = join(root, "disabled");
  const log = join(root, "log");
  await writeFile(
    loaded,
    options.loaded.map((label) => `system/${label}\n`).join(""),
  );
  await writeFile(disabled, "");
  const stubs: Record<string, string> = {
    sudo: '#!/bin/sh\nexec "$@"\n',
    sleep: "#!/bin/sh\nexit 0\n",
    caddy: `#!/bin/sh\necho "caddy $*" >> ${JSON.stringify(log)}\n`,
    curl: `#!/bin/sh\necho "curl $*" >> ${JSON.stringify(log)}\n`,
    rig: `#!/bin/sh\necho "rig $*" >> ${JSON.stringify(log)}\nexit \${RIG_FAILS:-0}\n`,
    launchctl: [
      "#!/bin/sh",
      `loaded=${JSON.stringify(loaded)}; disabled=${JSON.stringify(disabled)}; log=${JSON.stringify(log)}`,
      'case "$1" in print) ;; *) echo "launchctl $*" >> "$log";; esac',
      'case "$1" in',
      '  print) grep -qx "$2" "$loaded" && echo "	state = running";;',
      `  bootout) for s in ${(options.stuck ?? []).join(" ")}; do [ "$2" = "system/$s" ] && exit 5; done`,
      '    grep -vx "$2" "$loaded" > "$loaded.tmp"; mv "$loaded.tmp" "$loaded";;',
      '  disable) echo "$2" >> "$disabled";;',
      '  enable) grep -vx "$2" "$disabled" > "$disabled.tmp"; mv "$disabled.tmp" "$disabled";;',
      '  bootstrap) label="system/$(basename "$3" .plist)"',
      `    for s in ${(options.refused ?? []).join(" ")}; do [ "$label" = "system/$s" ] && exit 5; done`,
      '    grep -qx "$label" "$disabled" && exit 119',
      '    echo "$label" >> "$loaded";;',
      "esac",
      "",
    ].join("\n"),
  };
  for (const [name, text] of Object.entries(stubs)) {
    await writeFile(join(bin, name), text);
    await chmod(join(bin, name), 0o755);
  }
  const { functions, cutover } = await runbook();
  const prepare = functions.replaceAll("/usr/local/bin/caddy", "caddy");
  return {
    async run(script: string, env: Record<string, string> = {}) {
      const child = Bun.spawn(["/bin/bash", "-c", `${prepare}\n${script}`], {
        env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      return { code, stdout };
    },
    cutover,
    loaded: async () =>
      (await readFile(loaded, "utf8")).split("\n").filter(Boolean),
    disabled: async () =>
      (await readFile(disabled, "utf8")).split("\n").filter(Boolean),
    log: async () =>
      (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean),
  };
}
const RC = "com.b-relay.rig-caddy.d8063e9dcf1ba828";
const BC = "com.b-relay.b-caddy";

test("the rollback disables Rig's Caddy for good, confirms it is gone, then brings back b-caddy and the router", async () => {
  const s = await sandbox({ loaded: [RC] });
  const { stdout } = await s.run("rollback");
  expect(stdout).toContain("ROLLED BACK");
  expect(await s.loaded()).toEqual([`system/${BC}`]);
  // Disabled persists across a reboot: launchd would refuse to load it again until it is enabled.
  expect(await s.disabled()).toEqual([`system/${RC}`]);
  expect(await s.log()).toEqual([
    `launchctl disable system/${RC}`,
    `launchctl bootout system/${RC}`,
    `launchctl enable system/${BC}`,
    `launchctl bootstrap system /Library/LaunchDaemons/${BC}.plist`,
    "caddy reload --config /usr/local/etc/caddy-router.caddyfile",
    "curl -sS -o /dev/null --max-time 10 https://pantry.b-relay.com/",
  ]);
}, 30_000);

test("a rollback whose stop fails starts nothing and says it is incomplete", async () => {
  const s = await sandbox({ loaded: [RC], stuck: [RC] });
  const { stdout } = await s.run("rollback");
  expect(stdout).toContain("ROLLBACK INCOMPLETE");
  expect(stdout).not.toContain("ROLLED BACK");
  // b-caddy was not started next to a Caddy that may still hold the ports.
  expect(await s.loaded()).toEqual([`system/${RC}`]);
  expect((await s.log()).some((line) => line.includes("bootstrap"))).toBe(
    false,
  );
}, 30_000);

test("the cutover stops b-caddy first and, when Rig's Caddy cannot serve, rolls back by itself", async () => {
  const ok = await sandbox({ loaded: [BC, RC] });
  const done = await ok.run(ok.cutover);
  expect(done.stdout).toContain("CUT OVER");
  expect(await ok.loaded()).toEqual([`system/${RC}`]);
  expect(await ok.disabled()).toEqual([`system/${BC}`]);

  const failing = await sandbox({ loaded: [BC, RC] });
  const failed = await failing.run(failing.cutover, { RIG_FAILS: "1" });
  expect(failed.stdout).toContain("Cutover failed; rolling back.");
  expect(failed.stdout).toContain("ROLLED BACK");
  expect(await failing.loaded()).toEqual([`system/${BC}`]);
  expect(await failing.disabled()).toEqual([`system/${RC}`]);
}, 30_000);

test("after a rollback, cutting over again enables Rig's Caddy explicitly", async () => {
  const s = await sandbox({ loaded: [RC] });
  await s.run("rollback");
  const { stdout } = await s.run(s.cutover);
  expect(stdout).toContain("CUT OVER");
  expect(await s.loaded()).toEqual([`system/${RC}`]);
  expect(await s.disabled()).toEqual([`system/${BC}`]);
}, 30_000);
