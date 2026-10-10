import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyPaths } from "../src/domain/managed-proxy";
import { caddyCommand } from "../src/providers/caddy-job";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const TOKEN = "Syn_thetic-Token-0123456789abcdefABCDEF";

/** Runs the job's command with a stand-in Caddy that prints its arguments and the token file, as a Caddy quoting a rejected
 * token would: whatever it prints is what would reach the job's log. */
async function start(token: string | null) {
  const root = await mkdtemp(join(tmpdir(), "rig-guard-"));
  roots.push(root);
  const paths = proxyPaths(root);
  await mkdir(paths.bin, { recursive: true });
  await writeFile(
    paths.binary,
    `#!/bin/sh\necho "caddy $*"\n[ -e '${paths.token}' ] && echo "API token '$(cat '${paths.token}')' appears invalid"\nexit 0\n`,
  );
  await chmod(paths.binary, 0o755);
  if (token !== null) {
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(paths.token, token, { mode: 0o600 });
  }
  const child = Bun.spawn(caddyCommand(paths), {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, log: stdout + stderr, paths };
}

test("Caddy starts on a well-formed token, or none, and runs the current generation in the job's own process", async () => {
  const ok = await start(TOKEN);
  expect(ok.code).toBe(0);
  expect(ok.log).toContain(
    `caddy run --config ${ok.paths.entry} --adapter caddyfile`,
  );
  const none = await start(null);
  expect(none.code).toBe(0);
  expect(none.log).toContain("caddy run");
  // The plugin's longest form, and one byte past it.
  expect((await start(`cfut_${"x".repeat(256)}`)).code).toBe(0);
  expect((await start(`cfut_${"x".repeat(257)}`)).code).toBe(78);
});

test("a malformed token never reaches Caddy, so nothing the job logs contains it", async () => {
  for (const malformed of [
    `${TOKEN}\n`,
    ` ${TOKEN}`,
    `"${TOKEN}"`,
    `${TOKEN}${TOKEN}`,
    `${TOKEN}\n${TOKEN}`,
  ]) {
    const refused = await start(malformed);
    expect(refused.code).toBe(78);
    expect(refused.log).toContain("holds no well-formed Cloudflare API token");
    expect(refused.log).not.toContain("caddy run");
    expect(refused.log).not.toContain("Syn_thetic");
  }
});
