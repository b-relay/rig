import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyPaths } from "../src/domain/managed-proxy";
import {
  binaryPending,
  confirmBinary,
  installCaddyBinary,
  revertBinary,
} from "../src/providers/caddy-binary";
import type { CommandRunner } from "../src/providers/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
/** Every candidate answers as Caddy 2.10 with the DNS module, so only the activation bookkeeping is under test. */
const run: CommandRunner = async ({ command }) => ({
  exitCode: 0,
  stdout:
    command[1] === "version"
      ? "v2.10.2 h1:test\n"
      : "dns.providers.cloudflare\n",
  stderr: "",
});
async function world() {
  const root = await mkdtemp(join(tmpdir(), "rig-binary-"));
  roots.push(root);
  const paths = proxyPaths(root);
  const source = async (name: string) => {
    const file = join(root, name);
    await writeFile(file, `binary ${name}`);
    return file;
  };
  const install = (file: string) =>
    installCaddyBinary({ source: file, paths, dns: "cloudflare", run });
  const linked = async () => (await readlink(paths.binary)).split("/").at(-1);
  return { paths, source, install, linked };
}

test("a new copy stays pending until confirmed; an install killed before confirming is picked up again with its way back", async () => {
  const w = await world();
  const a = await w.install(await w.source("a"));
  expect(a).toMatchObject({ changed: true });
  expect(a.previous).toBeUndefined();
  expect(await binaryPending(w.paths)).toBe(true);
  await confirmBinary(w.paths);
  expect(await binaryPending(w.paths)).toBe(false);
  expect((await w.install(await w.source("a"))).changed).toBe(false);

  const b = await w.install(await w.source("b"));
  expect(b).toMatchObject({ changed: true, previous: a.file });
  // Killed after the switch, before the restart: the retry still has B to activate and A to go back to.
  const retried = await w.install(await w.source("b"));
  expect(retried).toMatchObject({ changed: true, previous: a.file });

  // A third copy switched to before B was confirmed goes back to A, the last one that served, never to B.
  const c = await w.install(await w.source("c"));
  expect(c).toMatchObject({ changed: true, previous: a.file });

  expect(await revertBinary(w.paths)).toBe(true);
  expect(await w.linked()).toBe(a.file.split("/").at(-1));
  expect(await binaryPending(w.paths)).toBe(false);
});

test("with nothing that ever served, or only a copy since deleted, there is nothing to go back to", async () => {
  const w = await world();
  const a = await w.install(await w.source("a"));
  expect(await revertBinary(w.paths)).toBe(false);
  await confirmBinary(w.paths);
  await w.install(await w.source("b"));
  await rm(a.file);
  expect(await revertBinary(w.paths)).toBe(false);
  // The job's link was left on the copy that exists.
  expect(await w.linked()).not.toBe(a.file.split("/").at(-1));
});
