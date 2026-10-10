import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostConfig } from "../src/config";
import type { ProxySettings } from "../src/config/proxy-schema";
import {
  createManagedCaddy,
  type CaddyJobState,
} from "../src/providers/managed-caddy";
import { bareHostname } from "../src/domain/managed-proxy";
import { routeFileHostnames } from "../src/providers/route-file";
import type { CommandRunner } from "../src/providers/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const TOKEN = "Syn_thetic-Token-0123456789abcdefABCDEF";
const app = (upstream: string | null = "127.0.0.1:3001") => ({
  key: "app",
  sites: [
    { hostname: "app.example.test", routes: [{ prefix: "/", upstream }] },
  ],
});

/** A stand-in for `caddy adapt`, shaped as Caddy's JSON is (checked against 2.10.2): Rig's sites and proxy.routes as
 * routes of one HTTPS server, the route file's text as the Rig routes' body, so two generations with the same content
 * adapt alike, and a site line `file_server` adapts to that handler, for the allowlist to refuse. */
async function fakeAdapt(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  const imported = /^import (\S+)$/m.exec(text)?.[1];
  const routesText = imported
    ? await readFile(imported, "utf8").catch(() => "")
    : "";
  const field = (pattern: RegExp) => pattern.exec(text)?.[1];
  const https = Number(field(/https_port (\d+)/));
  const routes = [
    ...routeFileHostnames(routesText).map((host) => ({
      match: [{ host: [bareHostname(host)] }],
      handle: [
        routesText.includes("file_server")
          ? { handler: "file_server", root: "/" }
          : { handler: "static_response", body: routesText },
      ],
      terminal: true,
    })),
    ...[...text.matchAll(/^(\S+) \{\n\treverse_proxy (\S+)\n\}$/gm)].map(
      (match) => ({
        match: [{ host: [match[1]!] }],
        handle: [
          {
            handler: "subroute",
            routes: [
              {
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: match[2]! }],
                  },
                ],
              },
            ],
          },
        ],
        terminal: true,
      }),
    ),
  ];
  return {
    admin: { listen: field(/admin "([^"]+)"/) },
    storage: {
      module: "file_system",
      root: field(/storage file_system (\S+)/),
    },
    apps: {
      http: {
        http_port: Number(field(/http_port (\d+)/)),
        https_port: https,
        servers: {
          srv0: {
            listen: [
              text.includes("default_bind 127.0.0.1")
                ? `127.0.0.1:${https}`
                : `:${https}`,
            ],
            routes,
          },
        },
      },
      tls: {
        automation: {
          policies: [
            {
              issuers: [
                text.includes("local_certs")
                  ? { module: "internal" }
                  : { module: "acme", ca: field(/cert_issuer acme (\S+)/) },
              ],
            },
          ],
        },
      },
    },
  };
}

/** A managed Caddy over a temporary root whose caddy, job and admin socket are scripted. `caddy.loaded` is what the fake
 * Caddy runs; a reload or restart loads a generation as real Caddy would. */
async function world(
  proxy: Record<string, unknown> = {},
  token: string | null = TOKEN,
) {
  const root = await mkdtemp(join(tmpdir(), "rig-managed-"));
  roots.push(root);
  await mkdir(join(root, "caddy", "bin"), { recursive: true });
  await writeFile(join(root, "caddy", "bin", "caddy-0000"), "");
  await symlink("caddy-0000", join(root, "caddy", "bin", "caddy"));
  if (token !== null) {
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(join(root, "auth", "acme-dns.token"), token, {
      mode: 0o600,
    });
  }
  let settings: ProxySettings = parseHostConfig({
    proxy: { caddy: "/usr/local/bin/caddy", ...proxy },
  }).proxy!;
  const commands: string[][] = [];
  const failures: { validate?: string; reload?: string } = {};
  const control = {
    reachable: true,
    state: "running" as CaddyJobState,
    restarts: 0,
    /** Set to make a reload succeed without Caddy loading anything. */
    ignoreReload: false,
    loaded: {} as unknown,
  };
  const run: CommandRunner = async ({ command }) => {
    commands.push([...command]);
    const verb = command[1]!;
    if (verb === "adapt")
      return {
        exitCode: 0,
        stdout: JSON.stringify(await fakeAdapt(command[3]!)),
        stderr: "",
      };
    const failure = failures[verb as "validate" | "reload"];
    if (failure) return { exitCode: 1, stdout: "", stderr: failure };
    if (verb === "reload" && !control.ignoreReload)
      control.loaded = command[3]!.endsWith(".json")
        ? JSON.parse(await readFile(command[3]!, "utf8"))
        : await fakeAdapt(command[3]!);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  let id = 0;
  const caddy = createManagedCaddy({
    root,
    settings: async () => settings,
    run,
    job: {
      state: async () => control.state,
      restart: async () => {
        control.restarts++;
        control.loaded = JSON.parse(
          await readFile(
            join(root, "caddy", "current", "adapted.json"),
            "utf8",
          ),
        );
      },
    },
    admin: {
      reachable: async () => control.reachable,
      config: async () => (control.reachable ? control.loaded : undefined),
    },
    generationId: () => `g${String(++id).padStart(3, "0")}`,
    reachableWaitMs: 300,
    now: () => new Date("2026-10-10T00:00:00.000Z"),
  });
  return {
    root,
    caddy,
    commands,
    failures,
    control,
    setSettings(next: Record<string, unknown>) {
      settings = parseHostConfig({
        proxy: { caddy: "/usr/local/bin/caddy", ...next },
      }).proxy!;
    },
    current: async () =>
      (await readlink(join(root, "caddy", "current")).catch(() => undefined))
        ?.split("/")
        .at(-1),
    generations: () =>
      readdir(join(root, "caddy", "generations"))
        .then((names) => names.sort())
        .catch(() => []),
    routes: () =>
      readFile(join(root, "proxy", "Caddyfile"), "utf8").catch(() => ""),
    file: (...parts: string[]) => readFile(join(root, ...parts), "utf8"),
    /** The generation the fake Caddy serves, by the route file it was given. */
    /** The route file the fake Caddy serves: the body its Rig routes carry, or nothing when it serves none. */
    servedRoutes: () => {
      const servers = (
        control.loaded as {
          apps?: {
            http?: {
              servers?: Record<
                string,
                { routes?: { handle?: { body?: string }[] }[] }
              >;
            };
          };
        }
      )?.apps?.http?.servers;
      const bodies = Object.values(servers ?? {}).flatMap((server) =>
        (server.routes ?? []).map((route) => route.handle?.[0]?.body ?? ""),
      );
      return bodies.find((body) => body.includes("# rig begin")) ?? "";
    },
    verbs: () => commands.map((command) => command[1]),
  };
}

test("a route change is published as a generation: adapted, allowlisted, validated, switched to, then reloaded and confirmed from what Caddy runs", async () => {
  const w = await world({ site: ["encode gzip"] });
  await w.caddy.router.apply(app());
  expect(await w.current()).toBe("g001");
  const generation = join(w.root, "caddy", "generations", "g001");
  const binary = join(w.root, "caddy", "bin", "caddy");
  expect(w.commands).toEqual([
    [
      binary,
      "adapt",
      "--config",
      join(generation, "Caddyfile"),
      "--adapter",
      "caddyfile",
    ],
    // Rig's config alone, which the allowlist holds the full one against.
    [
      binary,
      "adapt",
      "--config",
      join(generation, "base.Caddyfile"),
      "--adapter",
      "caddyfile",
    ],
    // Only the accepted JSON is provisioned: validation comes after the allowlist, never before it.
    [binary, "validate", "--config", join(generation, "adapted.json")],
    [binary, "reload", "--config", join(generation, "adapted.json")],
  ]);
  // The base imports Rig's routes without their site lines.
  const base = await w.file("caddy", "generations", "g001", "base.Caddyfile");
  expect(base).toContain(`import ${join(generation, "base-routes.caddy")}`);
  expect(
    await w.file("caddy", "generations", "g001", "base-routes.caddy"),
  ).not.toContain("encode gzip");
  const routes = await w.routes();
  expect(routes).toContain(
    "app.example.test {\n  reverse_proxy 127.0.0.1:3001\n  encode gzip\n}\n",
  );
  expect(await w.file("caddy", "generations", "g001", "routes.caddy")).toBe(
    routes,
  );
  expect(w.servedRoutes()).toBe(routes);
  expect(
    JSON.parse(await w.file("caddy", "generations", "g001", "adapted.json")),
  ).toEqual(w.control.loaded);
  const main = await w.file("caddy", "generations", "g001", "Caddyfile");
  expect(main).toContain(`import ${join(generation, "routes.caddy")}`);
  expect(main).toContain("*.example.test {\n\tabort\n}");
  // Rig writes no custom Caddy file for the owner: their own routes are proxy.routes in Host config.
  expect(
    await stat(join(w.root, "proxy", "custom.caddy")).catch(() => undefined),
  ).toBeUndefined();
  // An unchanged route is not published again: Caddy already runs it.
  const before = w.commands.length;
  await w.caddy.router.apply(app());
  expect(w.commands).toHaveLength(before);
});

test("a configuration Caddy rejects switches nothing, keeps what Caddy saw, restores the route file and never shows the token", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const routes = await w.routes();
  w.failures.validate = `Error: loading module 'cloudflare': API token '${TOKEN}' appears invalid`;
  const error = await w.caddy.router
    .apply(app("127.0.0.1:3002"))
    .catch((caught) => caught);
  expect(error).toMatchObject({ code: "ROUTE_VALIDATE" });
  expect(JSON.stringify(error)).not.toContain(TOKEN);
  expect(String(error.message)).toContain("[redacted]");
  expect(await w.current()).toBe("g001");
  expect(await w.routes()).toBe(routes);
  expect(await w.generations()).toContain("g002.rejected");
});

test("a failed reload switches back to the previous generation, serves it again and restores the route file", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const routes = await w.routes();
  w.failures.reload = "Error: connection reset";
  await expect(
    w.caddy.router.apply(app("127.0.0.1:3002")),
  ).rejects.toMatchObject({ code: "ROUTE_RELOAD" });
  expect(await w.current()).toBe("g001");
  expect(await w.routes()).toBe(routes);
  expect(w.servedRoutes()).toBe(routes);
});

test("a reload Caddy accepts but does not take is caught by reading back what Caddy runs", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  w.control.ignoreReload = true;
  await expect(
    w.caddy.router.apply(app("127.0.0.1:3002")),
  ).rejects.toMatchObject({ code: "PROXY_ACTIVATION" });
  expect(await w.current()).toBe("g001");
});

test("an unreachable Caddy that is confirmed stopped takes the change when it starts; one that may be running fails the change", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  w.control.reachable = false;
  w.control.state = "stopped";
  await w.caddy.router.apply(app(null));
  expect(await w.current()).toBe("g002");

  const routes = await w.routes();
  for (const state of ["running", "unknown"] as const) {
    w.control.state = state;
    await expect(
      w.caddy.router.apply(app("127.0.0.1:3009")),
    ).rejects.toMatchObject({ code: "PROXY_UNREACHABLE", details: { state } });
    expect(await w.current()).toBe("g002");
    expect(await w.routes()).toBe(routes);
  }
  expect(await w.caddy.router.withheld("app")).toEqual([
    { hostname: "app.example.test", prefix: "/" },
  ]);
});

test("crash after the route file was written but before Caddy served it: a removal is not done until Caddy serves it", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const served = await w.routes();
  // The crash: the source block is gone, the current generation and Caddy still route to the upstream.
  await writeFile(join(w.root, "proxy", "Caddyfile"), "");
  w.control.reachable = false;
  w.control.state = "running";
  // The block is already gone from the source, yet the removal fails: Caddy may still route to the upstream.
  await expect(w.caddy.router.remove("app")).rejects.toMatchObject({
    code: "PROXY_UNREACHABLE",
  });
  expect(w.servedRoutes()).toBe(served);
  // Once Caddy answers, the removal is published and only then resolves.
  w.control.reachable = true;
  await w.caddy.router.remove("app");
  expect(w.servedRoutes()).toBe("");
  expect(await w.current()).toBe("g002");
});

test("crash after the switch but before activation: Caddy is brought to the current generation before anything else changes", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const old = w.control.loaded;
  // A new generation is switched to while Caddy is stopped; Caddy then comes back on the old config (as after a crash
  // between the switch and the reload).
  w.control.reachable = false;
  w.control.state = "stopped";
  await w.caddy.router.apply(app("127.0.0.1:3002"));
  w.control.reachable = true;
  w.control.state = "running";
  w.control.loaded = old;
  expect(await w.caddy.republish()).toEqual({ published: false });
  expect(w.servedRoutes()).toContain("127.0.0.1:3002");
  expect(w.control.restarts).toBe(0);
});

test("crash after switching to a new CA: the restart it needed is still made, not a reload", async () => {
  const w = await world({ tls: { ca: "letsencrypt-staging" } });
  await w.caddy.router.apply(app());
  const staging = w.control.loaded;
  w.setSettings({ tls: { ca: "letsencrypt" } });
  w.control.reachable = false;
  w.control.state = "stopped";
  await w.caddy.republish();
  // Caddy comes back still holding the staging configuration and its certificates.
  w.control.reachable = true;
  w.control.state = "running";
  w.control.loaded = staging;
  await w.caddy.republish();
  expect(w.control.restarts).toBe(1);
  expect(JSON.stringify(w.control.loaded)).toContain(
    "acme-v02.api.letsencrypt.org",
  );
});

test("a change of CA restarts Caddy instead of reloading it, since a reload keeps the cached certificates", async () => {
  const w = await world({ tls: { ca: "letsencrypt-staging" } });
  await w.caddy.router.apply(app());
  w.setSettings({ tls: { ca: "letsencrypt" } });
  expect(await w.caddy.republish()).toEqual({ published: true });
  expect(w.control.restarts).toBe(1);
  expect(w.verbs().filter((verb) => verb === "reload")).toHaveLength(1);
  expect(await w.caddy.republish()).toEqual({ published: false });
});

test("republishing rewrites every owned block with the current site lines", async () => {
  const w = await world({
    site: ["header X-Rig on", "encode gzip"],
  });
  await w.caddy.router.apply(app());
  w.setSettings({ site: ["encode gzip"] });
  await w.caddy.republish();
  const routes = await w.routes();
  expect(routes).not.toContain("header X-Rig on");
  expect(routes).toContain("  encode gzip\n");
  expect(await w.file("caddy", "current", "routes.caddy")).toBe(routes);
  expect(w.servedRoutes()).toBe(routes);
  expect(w.control.restarts).toBe(0);
});

test("proxy.routes are served as plain reverse proxies, applied by a republish and recorded with the generation", async () => {
  const w = await world({ routes: { "own.example.test": 3005 } });
  await w.caddy.router.apply(app());
  const main = await w.file("caddy", "current", "Caddyfile");
  expect(main).toContain(
    "own.example.test {\n\treverse_proxy 127.0.0.1:3005\n}",
  );
  expect(
    JSON.parse(await w.file("caddy", "current", "generation.json")),
  ).toMatchObject({
    customRoutes: [
      { hostname: "own.example.test", upstream: "127.0.0.1:3005" },
    ],
  });
  expect(JSON.stringify(w.control.loaded)).toContain("127.0.0.1:3005");
  // An edit of Host config takes effect when rig proxy reload (or rigd's start) republishes; nothing else is needed.
  w.setSettings({
    routes: { "own.example.test": "localhost:3006", "two.example.test": 3007 },
  });
  expect(await w.caddy.republish()).toEqual({ published: true });
  expect(
    JSON.parse(await w.file("caddy", "current", "generation.json"))
      .customRoutes,
  ).toEqual([
    { hostname: "own.example.test", upstream: "localhost:3006" },
    { hostname: "two.example.test", upstream: "127.0.0.1:3007" },
  ]);
  expect(JSON.stringify(w.control.loaded)).toContain("127.0.0.1:3007");
  expect(await w.caddy.republish()).toEqual({ published: false });
});

test("one hostname is never both a Target's and the owner's, whatever scheme, port or case the Target's address has", async () => {
  // A Target asking for one of the owner's hostnames is refused, naming proxy.routes.
  const w = await world({ routes: { "own.example.test": 3005 } });
  for (const hostname of [
    "own.example.test",
    "OWN.example.test",
    "https://own.example.test:28443",
  ])
    await expect(
      w.caddy.router.apply({
        key: "own",
        sites: [
          { hostname, routes: [{ prefix: "/", upstream: "127.0.0.1:1" }] },
        ],
      }),
    ).rejects.toMatchObject({
      code: "ROUTE_CONFLICT",
      details: { owner: "proxy.routes in Host config" },
    });
  // A route the owner adds for a hostname a Target already serves, at an explicit address, is refused and changes nothing.
  const v = await world();
  await v.caddy.router.apply({
    key: "app",
    sites: [
      {
        hostname: "https://app.example.test:28443",
        routes: [{ prefix: "/", upstream: "127.0.0.1:3001" }],
      },
    ],
  });
  const served = await v.current();
  v.setSettings({ routes: { "app.example.test": 3005 } });
  await expect(v.caddy.republish()).rejects.toMatchObject({
    code: "PROXY_CONFIG_INVALID",
    message: expect.stringContaining(
      "proxy.routes in Host config names app.example.test, which a Target serves (https://app.example.test:28443)",
    ),
  });
  expect(await v.current()).toBe(served);
  expect(await v.generations()).toEqual([served!]);
});

test("site lines are held to the allowlist on what Caddy makes of them: a handler outside it is refused at its JSON path", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const accepted = await w.current();
  w.setSettings({ site: ["file_server"] });
  const error = await w.caddy.republish().catch((caught) => caught);
  expect(error).toMatchObject({
    code: "PROXY_CONFIG_INVALID",
    message: expect.stringContaining(
      "Rig refused the proxy configuration: $.apps.http.servers.srv0.routes[0].handle[0].handler file_server is not allowed",
    ),
  });
  expect(await w.current()).toBe(accepted);
  expect(await w.generations()).toContain("g002.rejected");
  // The route file is put back, so Rig's routes keep their previous site lines.
  expect(await w.routes()).not.toContain("file_server");
});

test("custom Caddy files an earlier build read are ignored: nothing in them reaches a generation", async () => {
  const w = await world();
  await mkdir(join(w.root, "proxy"), { recursive: true });
  await writeFile(
    join(w.root, "proxy", "custom.caddy"),
    "app.example.test {\n\trespond takeover\n}\n",
  );
  await writeFile(
    join(w.root, "proxy", "custom-global.caddy"),
    "admin localhost:2999\n",
  );
  await w.caddy.router.apply(app());
  const names = await readdir(join(w.root, "caddy", "current"));
  expect(names.some((name) => name.startsWith("custom"))).toBe(false);
  expect(JSON.stringify(w.control.loaded)).not.toContain("takeover");
  expect(JSON.stringify(w.control.loaded)).not.toContain("2999");
});

test("a republish takes the current site lines too, and a failed rollback is reported, not claimed", async () => {
  const w = await world({ site: ["header X-Rig on"] });
  await w.caddy.router.apply(app());
  w.setSettings({ site: [] });
  await w.caddy.republish();
  expect(await w.routes()).not.toContain("header X-Rig on");

  w.failures.reload = "Error: loading new config: boom";
  const error = await w.caddy.router
    .apply(app("127.0.0.1:3002"))
    .catch((caught) => caught);
  expect(error).toMatchObject({ code: "ROUTE_RELOAD" });
  // Caddy still runs the previous generation, so serving it again needed nothing: the rollback stands.
  expect(error.details.rollbackReloaded).toBeUndefined();
});

test("without a well-formed token nothing is published, and the token never appears in the error", async () => {
  const missing = await world({}, null);
  await expect(missing.caddy.router.apply(app())).rejects.toMatchObject({
    code: "PROXY_TOKEN",
  });
  expect(missing.commands).toEqual([]);
  expect(await missing.routes()).toBe("");

  const malformed = await world({}, `${TOKEN} ${TOKEN}`);
  const error = await malformed.caddy.router
    .apply(app())
    .catch((caught) => caught);
  expect(error).toMatchObject({ code: "PROXY_TOKEN" });
  expect(JSON.stringify(error)).not.toContain(TOKEN);
  const internal = await world({ tls: { ca: "internal" } }, null);
  await internal.caddy.router.apply(app());
  expect(await internal.current()).toBe("g001");
});

test("the route file is written through a symlink and keeps its mode, so the old router can still read it", async () => {
  const w = await world();
  const real = join(w.root, "shared-routes.caddy");
  await writeFile(real, "", { mode: 0o644 });
  await mkdir(join(w.root, "proxy"), { recursive: true });
  await symlink(real, join(w.root, "proxy", "Caddyfile"));
  await w.caddy.router.apply(app());
  expect(await readFile(real, "utf8")).toContain("app.example.test {");
  expect((await stat(real)).mode & 0o777).toBe(0o644);
  expect(
    (await lstat(join(w.root, "proxy", "Caddyfile"))).isSymbolicLink(),
  ).toBe(true);
});

test("old generations are pruned to the current one and four before it", async () => {
  const w = await world();
  for (let port = 3001; port <= 3009; port++)
    await w.caddy.router.apply(app(`127.0.0.1:${port}`));
  expect(await w.generations()).toEqual([
    "g005",
    "g006",
    "g007",
    "g008",
    "g009",
  ]);
  expect(await w.current()).toBe("g009");
});

test("a Caddy whose job runs but whose socket opens a moment later is waited for, not failed", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  // At boot launchd shows the job running before Caddy listens on its socket.
  w.control.reachable = false;
  w.control.state = "running";
  setTimeout(() => (w.control.reachable = true), 100);
  await w.caddy.router.apply(app("127.0.0.1:3002"));
  expect(w.servedRoutes()).toContain("127.0.0.1:3002");
});

test("when reconciling fails, the error says nothing was changed rather than claiming a rollback", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  // Caddy runs something other than the current generation, and refuses to reload.
  w.control.loaded = {};
  w.failures.reload = "Error: boom";
  const error = await w.caddy.router
    .apply(app("127.0.0.1:3002"))
    .catch((caught) => caught);
  expect(error).toMatchObject({ code: "ROUTE_RELOAD" });
  expect(error.message).toContain("nothing was changed");
  expect(error.message).not.toContain("restored");
});
