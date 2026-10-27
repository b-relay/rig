import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { managedCaddyWorld, TOKEN } from "./support/managed-caddy-double";
import { createManagedCaddy } from "../src/providers/managed-caddy";
import { parseHostConfig } from "../src/config";
import { RigError } from "../src/domain/errors";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const app = (upstream: string | null = "127.0.0.1:3001") => ({
  key: "app",
  sites: [
    { hostname: "app.example.test", routes: [{ prefix: "/", upstream }] },
  ],
});
async function world(
  ...args: Parameters<typeof managedCaddyWorld>
): ReturnType<typeof managedCaddyWorld> {
  const made = await managedCaddyWorld(...args);
  roots.push(made.root);
  return made;
}

test("a route change is published as a generation: adapted, validated as the frozen JSON, switched to, then reloaded and confirmed from what Caddy runs", async () => {
  const w = await world();
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
    // Only the frozen JSON is provisioned, and it is exactly what Caddy will load.
    [binary, "validate", "--config", join(generation, "adapted.json")],
    // Loaded by rigd itself through Caddy's admin socket, never by a process of its own.
    ["admin", "load"],
  ]);
  const routes = await w.routes();
  expect(routes).toContain(
    "app.example.test {\n  reverse_proxy 127.0.0.1:3001\n}\n",
  );
  expect(await w.file("caddy", "generations", "g001", "routes.caddy")).toBe(
    routes,
  );
  expect(w.servedRoutes()).toBe(routes);
  const adapted = JSON.parse(
    await w.file("caddy", "generations", "g001", "adapted.json"),
  );
  expect(adapted).toEqual(w.control.loaded);
  // Rig's own page for an upstream that is down, on every server.
  expect(adapted.apps.http.servers.srv0.errors.routes[0].handle[0]).toEqual({
    handler: "static_response",
    status_code: "{http.error.status_code}",
    headers: { "Content-Type": ["text/plain; charset=utf-8"] },
    body: "{http.error.status_code} - {http.request.host} is currently down",
  });
  // Every value in the main file is quoted.
  const main = await w.file("caddy", "generations", "g001", "Caddyfile");
  expect(main).toContain(`import "${join(generation, "routes.caddy")}"`);
  expect(main).toContain('"*.example.test" {\n\tabort\n}');
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
  expect(w.verbs().filter((verb) => verb === "load")).toHaveLength(1);
  expect(await w.caddy.republish()).toEqual({ published: false });
});

test("a CA change whose restart stops Caddy and cannot start it again rolls back to the previous generation and starts Caddy on it", async () => {
  const w = await world({ tls: { ca: "internal" } });
  await w.caddy.router.apply(app());
  const old = await w.current();
  const served = w.control.loaded;
  w.control.failingRestarts = 1;
  w.setSettings({ tls: { ca: "https://127.0.0.1:65534/acme" } });
  const failure = await w.caddy.republish().catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "PROXY_START",
    message: expect.stringContaining(
      "; the previous configuration was restored.",
    ),
  });
  expect(
    (failure as { details?: Record<string, unknown> }).details,
  ).not.toHaveProperty("rollbackReloaded");
  expect(await w.current()).toBe(old);
  // Started again, on the previous generation: serving, not only linked.
  expect(w.control.restarts).toBe(2);
  expect(w.control.state).toBe("running");
  expect(w.control.loaded).toEqual(served);
});

test("when the previous generation cannot start either, the failed rollback is reported, not a restored configuration", async () => {
  const w = await world({ tls: { ca: "internal" } });
  await w.caddy.router.apply(app());
  const old = await w.current();
  w.control.failingRestarts = 2;
  w.setSettings({ tls: { ca: "https://127.0.0.1:65534/acme" } });
  const failure = await w.caddy.republish().catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "PROXY_START",
    hint: expect.stringContaining(
      "Serving the previous configuration again failed too",
    ),
    details: { rollbackReloaded: false },
  });
  expect((failure as Error).message).not.toContain("restored");
  expect(await w.current()).toBe(old);
  expect(w.control.restarts).toBe(2);
});

/** A restart, the `at`th, that stops Caddy and then waits until its signal aborts, as one `close` cuts short does. */
function cutShort(w: Awaited<ReturnType<typeof world>>, at: number) {
  return async (signal?: AbortSignal) => {
    if (w.control.restarts !== at) return;
    w.control.state = "stopped";
    w.control.reachable = false;
    await new Promise((resolve) =>
      signal?.aborted
        ? resolve(undefined)
        : signal?.addEventListener("abort", resolve, { once: true }),
    );
    throw new RigError(
      "PROXY_START",
      "The restart of Rig's Caddy was cancelled before it answered.",
      "Rig's Caddy may still be starting.",
    );
  };
}

test("a Caddy left stopped by a restart that rigd's stop cut short is started again by the next rigd: a CA change's restart, and a rollback's start", async () => {
  // 1: the CA change's own restart is cut short. 2: it fails, and the rollback's start is cut short.
  for (const at of [1, 2]) {
    const w = await world({ tls: { ca: "internal" } });
    await w.caddy.router.apply(app());
    const served = w.control.loaded;
    const previous = await w.current();
    if (at === 2) w.control.failingRestarts = 1;
    w.control.beforeRestart = cutShort(w, at);
    w.setSettings({ tls: { ca: "https://127.0.0.1:65534/acme" } });
    const publishing = w.caddy.republish().catch((error: unknown) => error);
    while (w.control.restarts < at || w.control.state !== "stopped")
      await Bun.sleep(5);
    await w.caddy.close();
    expect(await publishing).toBeInstanceOf(RigError);
    expect(w.control.state).toBe("stopped");
    expect(await w.current()).toBe(previous);
    // The next rigd starts Caddy on the current generation before it trusts what Caddy serves.
    const next = w.reopen();
    expect(await next.served()).toMatchObject({ https: 443 });
    expect(w.control.restarts).toBe(at + 1);
    expect(w.control.state as string).toBe("running");
    expect(w.control.loaded).toEqual(served);
    expect(
      await stat(join(w.root, "caddy", "restore.json")).catch(() => undefined),
    ).toBeUndefined();
    // Done once: the rigd after a clean stop of that one restarts nothing.
    await next.close();
    await w.reopen().served();
    expect(w.control.restarts).toBe(at + 1);
  }
});

test("a rollback to a Caddy that never stopped owes no restart: an owner's stop afterwards is kept by the next rigd", async () => {
  const w = await world({ tls: { ca: "internal" } });
  await w.caddy.router.apply(app());
  const restore = join(w.root, "caddy", "restore.json");
  // The CA change's restart is refused before Caddy stops: the old process serves the previous generation throughout.
  let recorded = false;
  w.control.beforeRestart = async () => {
    recorded = (await stat(restore).catch(() => undefined)) !== undefined;
    throw new RigError(
      "PROXY_START",
      "Caddy did not exit before the deadline.",
      "Retry.",
    );
  };
  w.setSettings({ tls: { ca: "https://127.0.0.1:65534/acme" } });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    code: "PROXY_START",
    message: expect.stringContaining("the previous configuration was restored"),
  });
  // Written before the restart was asked for, and ended once Caddy was confirmed to serve the previous generation.
  expect(recorded).toBe(true);
  expect(await stat(restore).catch(() => undefined)).toBeUndefined();
  w.control.beforeRestart = undefined;
  await w.caddy.close();
  // Its owner stops Caddy; the next rigd leaves it stopped.
  w.control.state = "stopped";
  w.control.reachable = false;
  const restarts = w.control.restarts;
  await w.reopen().served();
  expect(w.control.restarts).toBe(restarts);
  expect(w.control.state as string).toBe("stopped");
});

test("a Caddy its owner stopped stays stopped for the next rigd", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  w.control.state = "stopped";
  w.control.reachable = false;
  await w.reopen().served();
  expect(w.control.restarts).toBe(0);
  expect(w.control.state).toBe("stopped");
});

test("republishing rewrites every owned block, dropping directives an external router's extra_config left in them", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const routesFile = join(w.root, "proxy", "Caddyfile");
  await writeFile(
    routesFile,
    (await w.routes()).replace(
      "  reverse_proxy 127.0.0.1:3001\n",
      "  reverse_proxy 127.0.0.1:3001\n  import cloudflare\n",
    ),
  );
  await w.caddy.republish();
  const routes = await w.routes();
  expect(routes).not.toContain("import cloudflare");
  expect(await w.file("caddy", "current", "routes.caddy")).toBe(routes);
  expect(w.servedRoutes()).toBe(routes);
  expect(w.control.restarts).toBe(0);
});
test("proxy.routes are served as plain reverse proxies, applied by a republish and recorded with the generation", async () => {
  const w = await world({ routes: { "own.example.test": 3005 } });
  await w.caddy.router.apply(app());
  const main = await w.file("caddy", "current", "Caddyfile");
  expect(main).toContain(
    '"own.example.test" {\n\treverse_proxy "127.0.0.1:3005"\n}',
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
    code: "ROUTE_CONFLICT",
    message: expect.stringContaining("would belong to two owners"),
  });
  expect(await v.current()).toBe(served);
  expect(await v.generations()).toEqual([served!]);
});

test("Host config Rig refuses is recorded as pending and never blocks a route change: those keep the accepted settings", async () => {
  const w = await world({ routes: { "own.example.test": 3005 } });
  await w.caddy.router.apply(app());
  const accepted = await w.current();
  // The owner adds a route for a hostname a Target serves.
  w.setSettings({
    routes: { "own.example.test": 3005, "app.example.test": 3006 },
  });
  const error = await w.caddy.republish().catch((caught) => caught);
  expect(error).toMatchObject({
    code: "ROUTE_CONFLICT",
    message: expect.stringContaining(
      "app.example.test would belong to two owners",
    ),
    hint: expect.stringContaining("last accepted"),
    details: { pending: true },
  });
  expect(await w.current()).toBe(accepted);
  expect(
    JSON.parse(await w.file("caddy", "settings-rejected.json")),
  ).toMatchObject({
    code: "ROUTE_CONFLICT",
    reason: expect.stringContaining(
      "app.example.test would belong to two owners",
    ),
  });
  // Another Project's route still publishes, with the settings Caddy accepted: the refused route is not in it.
  await w.caddy.router.apply({
    key: "other",
    sites: [
      {
        hostname: "other.example.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:3009" }],
      },
    ],
  });
  await w.caddy.router.apply(app("127.0.0.1:3002"));
  const metadata = JSON.parse(
    await w.file("caddy", "current", "generation.json"),
  );
  expect(metadata.customRoutes).toEqual([
    { hostname: "own.example.test", upstream: "127.0.0.1:3005" },
  ]);
  expect(w.servedRoutes()).toContain("127.0.0.1:3002");
  expect(w.servedRoutes()).toContain("other.example.test");
  // Fixed Host config is accepted, and the record goes.
  w.setSettings({
    routes: { "own.example.test": 3005, "new.example.test": 3006 },
  });
  expect(await w.caddy.republish()).toEqual({ published: true });
  expect(
    await stat(join(w.root, "caddy", "settings-rejected.json")).catch(
      () => undefined,
    ),
  ).toBeUndefined();
});

test("a route check refuses what apply would, against the accepted routes, and changes nothing", async () => {
  const w = await world({ routes: { "own.example.test": 3005 } });
  await w.caddy.router.apply(app());
  const commands = w.commands.length;
  await expect(
    w.caddy.router.check!({
      key: "b",
      sites: [
        {
          hostname: "OWN.example.test",
          routes: [{ prefix: "/", upstream: "127.0.0.1:1" }],
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "ROUTE_CONFLICT" });
  await expect(
    w.caddy.router.check!({
      key: "b",
      sites: [
        {
          hostname: "app.example.test",
          routes: [{ prefix: "/", upstream: "127.0.0.1:1" }],
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "ROUTE_CONFLICT" });
  await w.caddy.router.check!({
    key: "b",
    sites: [
      {
        hostname: "b.example.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:1" }],
      },
    ],
  });
  expect(w.commands).toHaveLength(commands);
  expect(await w.routes()).not.toContain("b.example.test");
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

test("a failed rollback is reported, not claimed", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
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

test("in managed mode the route file is only what Rig renders: text an external router's extra_config left past an early end marker is dropped, never published", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const token = /# rig begin ([0-9a-f]{64})/.exec(await w.routes())![1]!;
  // What `extra_config: ["# rig end <token>", "}", "evil.example.test {", "respond pwned"]` once rendered.
  const injected = [
    `# rig begin ${token}`,
    "app.example.test {",
    "  reverse_proxy 127.0.0.1:3001",
    `  # rig end ${token}`,
    "}",
    "evil.example.test {",
    "  respond pwned",
    "}",
    `# rig end ${token}`,
    "",
  ].join("\n");
  await writeFile(join(w.root, "proxy", "Caddyfile"), injected);
  expect(await w.caddy.republish()).toEqual({ published: true });
  const routes = await w.routes();
  expect(routes).toBe(
    `# rig begin ${token}\napp.example.test {\n  reverse_proxy 127.0.0.1:3001\n}\n# rig end ${token}\n`,
  );
  expect(w.servedRoutes()).toBe(routes);
  expect(JSON.stringify(w.control.loaded)).not.toContain("pwned");
  // A route change rewrites such a file too, before anything is published.
  await writeFile(join(w.root, "proxy", "Caddyfile"), injected);
  await w.caddy.router.apply(app("127.0.0.1:3002"));
  expect(await w.routes()).not.toContain("evil");
  expect(w.servedRoutes()).not.toContain("evil");
});

test("a hostname a deploy checked is reserved until the deploy lets go: Host config published in between cannot claim it", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const b = {
    key: "b",
    sites: [
      {
        hostname: "new.example.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:3010" }],
      },
    ],
  };
  await w.caddy.router.check!(b);
  // rig proxy reload adds a route for it mid-deploy.
  w.setSettings({ routes: { "new.example.test": 3005 } });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    message: expect.stringContaining("which a deploy is about to publish"),
  });
  // The deploy publishes its route; the hostname is the Target's from then on.
  await w.caddy.router.apply(b);
  expect(w.servedRoutes()).toContain("new.example.test");
  await expect(w.caddy.republish()).rejects.toMatchObject({
    message: expect.stringContaining("would belong to two owners"),
  });
  // A route change during the deploy does not end the reservation; the deploy's release does.
  await w.caddy.router.check!({
    ...b,
    key: "c",
    sites: [{ ...b.sites[0]!, hostname: "c.example.test" }],
  });
  await w.caddy.router.remove("c");
  w.setSettings({ routes: { "c.example.test": 3005 } });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    message: expect.stringContaining("which a deploy is about to publish"),
  });
  await w.caddy.router.release!("c");
  expect(await w.caddy.republish()).toEqual({ published: true });
});

test("a deploy reserves the hostnames its route serves now as well as the candidate's, and a restoration honours reservations", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const saved = await w.caddy.router.checkpoint("app");
  // Deploying the Target to another hostname: app.example.test is what a rollback restores.
  await w.caddy.router.check!({
    key: "app",
    sites: [
      {
        hostname: "next.example.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:3002" }],
      },
    ],
  });
  await w.caddy.router.apply({
    key: "app",
    sites: [
      {
        hostname: "next.example.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:3002" }],
      },
    ],
  });
  // The route file no longer holds app.example.test, but a reload still cannot claim it before the deploy is decided.
  w.setSettings({ routes: { "app.example.test": 3005 } });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    message: expect.stringContaining("which a deploy is about to publish"),
  });
  // Nor can another deploy.
  await expect(
    w.caddy.router.check!({
      key: "other",
      sites: [
        {
          hostname: "app.example.test",
          routes: [{ prefix: "/", upstream: "127.0.0.1:1" }],
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "ROUTE_CONFLICT" });
  // The rollback restores it.
  const expected = await w.caddy.router.checkpoint("app");
  await w.caddy.router.restore(saved, expected);
  expect(w.servedRoutes()).toContain("app.example.test");
  await w.caddy.router.release!("app");

  // A restoration of a hostname another deploy has reserved is refused.
  const v = await world();
  await v.caddy.router.apply(app());
  const kept = await v.caddy.router.checkpoint("app");
  await v.caddy.router.remove("app");
  await v.caddy.router.check!({
    key: "other",
    sites: [
      {
        hostname: "app.example.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:1" }],
      },
    ],
  });
  await expect(
    v.caddy.router.restore(kept, await v.caddy.router.checkpoint("app")),
  ).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    details: { owner: "another deploy" },
  });
});

test("a generation without the settings it was accepted with is no last-good: route changes publish Host config as it is, as before the first generation", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  // Shaped like one built before generations recorded their settings (none was ever released).
  const metadataFile = join(w.root, "caddy", "current", "generation.json");
  const { proxy: _, ...older } = JSON.parse(
    await readFile(metadataFile, "utf8"),
  );
  await writeFile(metadataFile, JSON.stringify(older));
  w.setSettings({ routes: { "own.example.test": 3005 } });
  await w.caddy.router.apply(app("127.0.0.1:3002"));
  expect(
    JSON.parse(await w.file("caddy", "current", "generation.json")),
  ).toMatchObject({
    customRoutes: [
      { hostname: "own.example.test", upstream: "127.0.0.1:3005" },
    ],
  });
});

test("two deploys cannot reserve one hostname: the second is refused at its check, and apply honours another's reservation", async () => {
  const w = await world();
  const route = (key: string) => ({
    key,
    sites: [
      {
        hostname: "shared.example.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:3010" }],
      },
    ],
  });
  await w.caddy.router.check!(route("a"));
  // The same Target checking again is its own reservation, not a conflict.
  await w.caddy.router.check!(route("a"));
  await expect(w.caddy.router.check!(route("b"))).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    details: { owner: "another deploy" },
  });
  await expect(w.caddy.router.apply(route("b"))).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
  });
  // Once the first deploy is decided and lets go, the hostname is free again.
  await w.caddy.router.release!("a");
  await w.caddy.router.check!(route("b"));
});

test("one owner per hostname, at the write point: every publication path refuses a route file or Host config that gives a hostname two owners", async () => {
  const w = await world();
  const site = (key: string, hostname: string) => ({
    key,
    sites: [
      { hostname, routes: [{ prefix: "/", upstream: "127.0.0.1:3001" }] },
    ],
  });
  await w.caddy.router.apply(site("a", "one.example.test"));
  await w.caddy.router.apply(site("b", "two.example.test"));
  await w.caddy.router.apply(site("d", "four.example.test"));
  const savedD = await w.caddy.router.checkpoint("d");
  await w.caddy.router.apply(site("d", "five.example.test"));
  const served = await w.current();
  // However it came about (a bug, a crash, a hand edit), b's block now claims a's hostname as well.
  const routesFile = join(w.root, "proxy", "Caddyfile");
  await writeFile(
    routesFile,
    (await w.routes()).replace("two.example.test {", "one.example.test {"),
  );
  const duplicate = await w.routes();
  const refused = {
    code: "ROUTE_CONFLICT",
    hint: expect.stringContaining(
      "change the domain of the Target that should give it up and apply it",
    ),
  };
  // Every path that would publish the file refuses it, before writing anything.
  const paths: [string, () => Promise<unknown>][] = [
    ["apply", () => w.caddy.router.apply(site("c", "three.example.test"))],
    [
      "restore (a rollback or a recovery stop)",
      async () =>
        w.caddy.router.restore(savedD, await w.caddy.router.checkpoint("d")),
    ],
    [
      "remove of a route that is not one of the two owners",
      () => w.caddy.router.remove("d"),
    ],
    ["republish (rigd's start, rig proxy reload)", () => w.caddy.republish()],
  ];
  for (const [name, publish] of paths) {
    await writeFile(routesFile, duplicate);
    const error = await publish().then(
      () => undefined,
      (caught) => caught,
    );
    expect({ name, error }).toMatchObject({ name, error: refused });
    expect(await w.current()).toBe(served);
    expect(await w.routes()).toBe(duplicate);
  }
  // A change with nothing of its own to publish (removing a route that is not there, rolling back one that never changed)
  // publishes nothing and succeeds.
  await w.caddy.router.remove("absent");
  const unchanged = await w.caddy.router.checkpoint("a");
  await w.caddy.router.restore(unchanged, unchanged);
  expect(await w.current()).toBe(served);
  // Removing one of the two owners is the way out, and it publishes.
  await writeFile(routesFile, duplicate);
  await w.caddy.router.remove("b");
  expect(w.servedRoutes()).toContain("one.example.test");
  // A reload whose proxy.routes claims a Target's hostname is refused the same way.
  w.setSettings({ routes: { "one.example.test": 3005 } });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    details: {
      hostname: "one.example.test",
      owners: [
        expect.stringContaining("Target route"),
        "proxy.routes in Host config",
      ],
    },
  });
});

test("a restoration cannot take a hostname another Target has committed since: it is refused, not published twice", async () => {
  const w = await world();
  const site = (key: string, hostname: string, upstream: string) => ({
    key,
    sites: [{ hostname, routes: [{ prefix: "/", upstream }] }],
  });
  await w.caddy.router.apply(site("a", "old.example.test", "127.0.0.1:3001"));
  const saved = await w.caddy.router.checkpoint("a");
  // A moves to another hostname; its rollback is delayed.
  await w.caddy.router.apply(site("a", "new.example.test", "127.0.0.1:3001"));
  // B commits A's old hostname and lets go of its reservation.
  await w.caddy.router.apply(site("b", "old.example.test", "127.0.0.1:4001"));
  // A's recovery now restores its old block: refused, so old.example.test keeps one owner and one upstream.
  await expect(
    w.caddy.router.restore(saved, await w.caddy.router.checkpoint("a")),
  ).rejects.toMatchObject({ code: "ROUTE_CONFLICT" });
  expect(w.servedRoutes().match(/old\.example\.test \{/g)).toHaveLength(1);
  expect(w.servedRoutes()).toContain("127.0.0.1:4001");
});

test("ownership is checked on the prospective file before any write: a refused restoration leaves no duplicate in the route file, its backup or a generation", async () => {
  const w = await world();
  const site = (key: string, hostname: string, upstream: string) => ({
    key,
    sites: [{ hostname, routes: [{ prefix: "/", upstream }] }],
  });
  await w.caddy.router.apply(site("a", "old.example.test", "127.0.0.1:3001"));
  const saved = await w.caddy.router.checkpoint("a");
  await w.caddy.router.apply(site("a", "new.example.test", "127.0.0.1:3001"));
  await w.caddy.router.apply(site("b", "old.example.test", "127.0.0.1:4001"));
  const routes = await w.routes();
  const backup = await w.file("proxy", "Caddyfile.rig-backup");
  const generations = await w.generations();
  await expect(
    w.caddy.router.restore(saved, await w.caddy.router.checkpoint("a")),
  ).rejects.toMatchObject({ code: "ROUTE_CONFLICT" });
  // Nothing was written: not the route file, not its backup, not a generation (not even a rejected one).
  expect(await w.routes()).toBe(routes);
  expect(await w.file("proxy", "Caddyfile.rig-backup")).toBe(backup);
  expect(await w.generations()).toEqual(generations);
  for (const text of [await w.routes(), backup])
    expect(text.match(/old\.example\.test \{/g) ?? []).toHaveLength(
      text.includes("old.example.test") ? 1 : 0,
    );
  // A reload whose proxy.routes would duplicate a Target's hostname writes nothing either.
  w.setSettings({ routes: { "new.example.test": 3005 } });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
  });
  expect(await w.generations()).toEqual(generations);
});

test("close cancels the Caddy command under way, refuses every change after it, and resolves once nothing of the queue runs", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  // The next reload is held until its command is cancelled.
  let cancelled = false;
  w.control.afterLoad = (signal) =>
    new Promise<void>((_, reject) => {
      signal?.addEventListener("abort", () => {
        cancelled = true;
        reject(new Error("cancelled"));
      });
    });
  const reloads = () => w.verbs().filter((verb) => verb === "load").length;
  const before = reloads();
  const held = w.caddy.router.apply(app("127.0.0.1:3002"));
  const queued = w.caddy.router.apply(app("127.0.0.1:3003"));
  for (let i = 0; i < 200 && reloads() === before; i++) await Bun.sleep(10);
  await w.caddy.close();
  expect(cancelled).toBe(true);
  await expect(held).rejects.toBeDefined();
  await expect(queued).rejects.toMatchObject({ code: "PROXY_CLOSED" });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    code: "PROXY_CLOSED",
  });
});

test("after an earlier rigd's unclean stop Caddy is restarted before anything reads what it serves; after a clean one it is not", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  // This publisher stops in order: it records that nothing it sent can reach Caddy any more.
  await w.caddy.close();
  const cleanStop = join(w.root, "caddy", "clean-stop.json");
  await stat(cleanStop);
  const next = () =>
    createManagedCaddy({
      root: w.root,
      settings: async () =>
        parseHostConfig({ proxy: { caddy: "/usr/local/bin/caddy" } }).proxy!,
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      job: {
        state: async () => "running",
        restart: async () => void events.push("restart"),
      },
      admin: {
        reachable: async () => true,
        config: async () => {
          events.push("read");
          return w.control.loaded;
        },
        load: async () => undefined,
      },
    });
  const events: string[] = [];
  // After a clean stop: the record is taken, and Caddy is read as it is.
  await next().refreshDashboard();
  expect(events).toEqual(["read"]);
  await expect(stat(cleanStop)).rejects.toThrow();
  // After an unclean one (no record): Caddy is restarted first.
  events.length = 0;
  await next().refreshDashboard();
  expect(events[0]).toBe("restart");
  expect(events).toContain("read");
});
