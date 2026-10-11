import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectProxyToken,
  writeProxyToken,
} from "../src/adapters/proxy-token";
import { inspectHost } from "../src/adapters/host-inspection";
import { inspectManagedProxy } from "../src/adapters/proxy-inspection";
import { parseHostConfig } from "../src/config";
import type { ProxySettings } from "../src/config/proxy-schema";
import { hostRoutes, settingsDigest } from "../src/domain/managed-proxy";
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
    {
      proxyToken: async () => "/r/auth/acme-dns.token",
      proxyVerify: async () => [],
    },
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

test("doctor names a custom Caddy file an earlier build read as ignored, and Host config Caddy does not serve: pending, or refused with why", async () => {
  const r = await root();
  await mkdir(join(r, "daemon"), { recursive: true });
  await writeFile(
    join(r, "daemon", "install.json"),
    JSON.stringify({ mode: "process" }),
  );
  await writeFile(
    join(r, "config.yaml"),
    "proxy:\n  caddy: /usr/local/bin/caddy\n  routes:\n    grafana.example.com: 3000\n",
  );
  await mkdir(join(r, "proxy"), { recursive: true });
  // An external router's extra_config left text past an early end marker.
  await writeFile(
    join(r, "proxy", "Caddyfile"),
    `# rig begin ${"a".repeat(64)}\napp.example.com {\n  reverse_proxy 127.0.0.1:1\n  # rig end ${"a".repeat(64)}\n}\nevil.example.com {\n  respond pwned\n}\n# rig end ${"a".repeat(64)}\n`,
  );
  await writeFile(
    join(r, "proxy", "custom.caddy"),
    "grafana.example.com {\n\treverse_proxy 127.0.0.1:3000\n}\n",
  );
  // A generation accepted before the route was added.
  const accepted = parseHostConfig({
    proxy: { caddy: "/usr/local/bin/caddy" },
  }).proxy!;
  const generation = join(r, "caddy", "generations", "g1");
  await mkdir(generation, { recursive: true });
  const record = (proxy: ProxySettings) =>
    writeFile(
      join(generation, "generation.json"),
      JSON.stringify({ proxy, customRoutes: hostRoutes(proxy) }),
    );
  await record(accepted);
  await symlink(join("generations", "g1"), join(r, "caddy", "current"));
  const checks = await inspectHost(r);
  expect(
    checks.find((check) => check.name === "proxy-route-file"),
  ).toMatchObject({
    ok: false,
    reason: "proxy-route-file-foreign",
    message: expect.stringContaining("holds text Rig did not write"),
  });
  expect(checks.filter((check) => check.name === "proxy-custom-file")).toEqual([
    {
      name: "proxy-custom-file",
      ok: false,
      message: `Rig no longer reads ${join(r, "proxy", "custom.caddy")}, so nothing in it is served.`,
      reason: "proxy-custom-retired",
      hint: expect.stringContaining("proxy.routes in config.yaml"),
    },
  ]);
  expect(checks.find((check) => check.name === "proxy-settings")).toMatchObject(
    {
      ok: false,
      reason: "proxy-settings-pending",
      message: expect.stringContaining("(routes)"),
      hint: expect.stringContaining("rig proxy reload"),
    },
  );
  // Refused: the reason Rig recorded for exactly these settings.
  const requested = parseHostConfig({
    proxy: {
      caddy: "/usr/local/bin/caddy",
      routes: { "grafana.example.com": 3000 },
    },
  }).proxy!;
  await writeFile(
    join(r, "caddy", "settings-rejected.json"),
    JSON.stringify({
      settings: settingsDigest(requested),
      code: "PROXY_CONFIG_INVALID",
      reason:
        "proxy.routes in Host config names grafana.example.com, which a Target serves (grafana.example.com).",
      at: "2026-10-10T00:00:00.000Z",
    }),
  );
  expect(
    (await inspectHost(r)).find((check) => check.name === "proxy-settings"),
  ).toMatchObject({
    ok: false,
    reason: "proxy-settings-refused",
    message: expect.stringContaining("which a Target serves"),
  });
  await record(requested);
  expect(
    (await inspectHost(r)).find((check) => check.name === "proxy-settings"),
  ).toMatchObject({ ok: true });
});

test("doctor pins one generation for the whole inspection: a publication that switches current meanwhile cannot mix two", async () => {
  const r = await root();
  const settings = parseHostConfig({
    proxy: { caddy: "/usr/local/bin/caddy", tls: { ca: "internal" } },
  }).proxy!;
  const newer = { ...settings, routes: { "new.example.com": 3000 } };
  const write = async (id: string, proxy: ProxySettings, adapted: unknown) => {
    const directory = join(r, "caddy", "generations", id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "generation.json"),
      JSON.stringify({ proxy, customRoutes: hostRoutes(proxy) }),
    );
    await writeFile(join(directory, "adapted.json"), JSON.stringify(adapted));
  };
  await write("g1", settings, { generation: 1 });
  await write("g2", newer, { generation: 2 });
  await symlink(join("generations", "g1"), join(r, "caddy", "current"));
  const switchToG2 = async () => {
    await symlink(join("generations", "g2"), join(r, "caddy", "next"));
    await rename(join(r, "caddy", "next"), join(r, "caddy", "current"));
  };
  // Caddy still runs g1 when doctor asks; a publication switches current to g2 at that very moment.
  const checks = await inspectManagedProxy(r, settings, "process", {
    admin: {
      reachable: async () => true,
      config: async () => {
        await switchToG2();
        return { generation: 1 };
      },
      stop: async () => true,
    },
    job: { state: async () => "running", description: "test job" },
  });
  const byName = new Map(checks.map((check) => [check.name, check]));
  // Both checks describe g1, the generation the inspection began with.
  expect(byName.get("proxy-serving")).toMatchObject({ ok: true });
  expect(byName.get("proxy-settings")).toMatchObject({ ok: true });
});
