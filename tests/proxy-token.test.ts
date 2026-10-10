import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectProxyToken,
  writeProxyToken,
} from "../src/adapters/proxy-token";
import { inspectHost } from "../src/adapters/host-inspection";
import { createRigCommand } from "../src/cli/commands";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const TOKEN = "Syn_thetic-Token-0123456789abcdefABCDEF";
async function root() {
  const path = await mkdtemp(join(tmpdir(), "rig-token-"));
  roots.push(path);
  return path;
}

test("the token is stored trimmed with mode 600, and a malformed one is refused without writing or echoing it", async () => {
  const r = await root();
  const path = await writeProxyToken(r, `  ${TOKEN}\n`);
  expect(path).toBe(join(r, "auth", "acme-dns.token"));
  expect(await readFile(path, "utf8")).toBe(TOKEN);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await inspectProxyToken(r)).toEqual({ state: "ok" });

  const error = await writeProxyToken(r, `${TOKEN} extra`).catch(
    (caught) => caught,
  );
  expect(error).toMatchObject({ code: "PROXY_TOKEN" });
  expect(JSON.stringify(error) + error.message).not.toContain("Syn_thetic");
  // The stored token is untouched by the refused one.
  expect(await readFile(path, "utf8")).toBe(TOKEN);
});

test("inspection names a missing, exposed or malformed token without revealing it", async () => {
  const r = await root();
  expect(await inspectProxyToken(r)).toEqual({ state: "missing" });
  await mkdir(join(r, "auth"), { recursive: true });
  const path = join(r, "auth", "acme-dns.token");
  await writeFile(path, TOKEN, { mode: 0o644 });
  await chmod(path, 0o644);
  expect(await inspectProxyToken(r)).toEqual({ state: "exposed", mode: 0o644 });
  await chmod(path, 0o600);
  await writeFile(path, `${TOKEN}\n`);
  expect(await inspectProxyToken(r)).toEqual({ state: "malformed" });
});

test("rig proxy token stores what the local command reads and prints only the path", async () => {
  const written: string[] = [];
  const output = {
    write: (text: string) => written.push(text),
    error: () => {},
  };
  const command = createRigCommand(
    "/",
    output,
    async () => {},
    () => new Date(),
    { proxyToken: async () => "/r/auth/acme-dns.token" },
  );
  command.exitOverride();
  await command.parseAsync(["proxy", "token"], { from: "user" });
  expect(written.join("")).toBe(
    "Stored the DNS API token in /r/auth/acme-dns.token (mode 600).\n",
  );
});

test("doctor checks Rig's own Caddy instead of a Host Caddyfile, and no longer needs caddy on PATH", async () => {
  const r = await root();
  await mkdir(join(r, "daemon"), { recursive: true });
  await writeFile(
    join(r, "daemon", "install.json"),
    JSON.stringify({ mode: "process" }),
  );
  await writeFile(
    join(r, "config.yaml"),
    "proxy:\n  caddy: /usr/local/bin/caddy\nproviders:\n  caddy: {}\n",
  );
  const checks = await inspectHost(r);
  const byName = new Map(checks.map((check) => [check.name, check]));
  expect(byName.get("caddy-proxy")).toBeUndefined();
  expect(byName.get("provider/caddy")).toBeUndefined();
  expect(byName.get("host-config/providers-caddy")).toMatchObject({
    ok: false,
  });
  expect(byName.get("proxy-token")).toMatchObject({
    ok: false,
    reason: "token-missing",
  });
  expect(byName.get("proxy-binary")).toMatchObject({ ok: false });
  expect(byName.get("proxy-process")).toMatchObject({
    ok: false,
    reason: "proxy-stopped",
  });
  expect(byName.get("proxy-config")).toMatchObject({
    ok: false,
    reason: "proxy-unconfigured",
  });
});
