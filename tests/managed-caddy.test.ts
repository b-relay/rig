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

/** A managed Caddy over a temporary root whose caddy, job and admin socket are scripted. */
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
  const run: CommandRunner = async ({ command }) => {
    commands.push([...command]);
    const verb = command[1] as "validate" | "reload";
    const failure = failures[verb];
    return failure
      ? { exitCode: 1, stdout: "", stderr: failure }
      : { exitCode: 0, stdout: "", stderr: "" };
  };
  const control = {
    reachable: true,
    state: "running" as CaddyJobState,
    restarts: 0,
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
      },
    },
    admin: { reachable: async () => control.reachable },
    generationId: () => `g${String(++id).padStart(3, "0")}`,
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
    verbs: () => commands.map((command) => command[1]),
  };
}

test("a route change is published as a generation: validated with Rig's Caddy, switched to, then reloaded from its own main file", async () => {
  const w = await world({ site: ["import backend_errors"] });
  await w.caddy.router.apply(app());
  expect(await w.current()).toBe("g001");
  const generation = join(w.root, "caddy", "generations", "g001");
  expect(w.commands).toEqual([
    [
      join(w.root, "caddy", "bin", "caddy"),
      "validate",
      "--config",
      join(generation, "Caddyfile"),
      "--adapter",
      "caddyfile",
    ],
    [
      join(w.root, "caddy", "bin", "caddy"),
      "reload",
      "--config",
      join(generation, "Caddyfile"),
      "--adapter",
      "caddyfile",
    ],
  ]);
  const routes = await w.routes();
  expect(routes).toContain(
    "app.example.test {\n  reverse_proxy 127.0.0.1:3001\n  import backend_errors\n}\n",
  );
  expect(await w.file("caddy", "generations", "g001", "routes.caddy")).toBe(
    routes,
  );
  const main = await w.file("caddy", "generations", "g001", "Caddyfile");
  expect(main).toContain(`import ${join(generation, "routes.caddy")}`);
  expect(main).toContain("*.example.test {\n\tabort\n}");
  // The custom files are created once, with their header, and copied into the generation.
  expect(await w.file("proxy", "custom.caddy")).toContain(
    "Rig never rewrites this file",
  );
  expect(await w.file("caddy", "generations", "g001", "custom.caddy")).toBe(
    await w.file("proxy", "custom.caddy"),
  );
  // An unchanged route is not published again.
  await w.caddy.router.apply(app());
  expect(w.commands).toHaveLength(2);
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
  expect(w.verbs()).toEqual(["validate", "reload", "validate"]);
});

test("a failed reload switches back to the previous generation, reloads it and restores the route file", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const routes = await w.routes();
  w.failures.reload = "Error: connection reset";
  await expect(
    w.caddy.router.apply(app("127.0.0.1:3002")),
  ).rejects.toMatchObject({ code: "ROUTE_RELOAD" });
  expect(await w.current()).toBe("g001");
  expect(await w.routes()).toBe(routes);
  const lastReload = w.commands.at(-1)!;
  expect(lastReload[1]).toBe("reload");
  expect(lastReload[3]).toBe(
    join(w.root, "caddy", "generations", "g001", "Caddyfile"),
  );
});

test("an unreachable Caddy that is confirmed stopped takes the change when it starts; one that may be running fails the change", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  w.control.reachable = false;
  w.control.state = "stopped";
  // A withdrawal is safe once Caddy is confirmed stopped: it reads the new generation when it starts.
  await w.caddy.router.apply(app(null));
  expect(await w.current()).toBe("g002");
  expect(w.verbs()).toEqual(["validate", "reload", "validate"]);

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

test("a withdrawal is published even when the route file already says it", async () => {
  const w = await world();
  await w.caddy.router.apply(app(null));
  await w.caddy.router.apply(app(null));
  expect(w.verbs()).toEqual(["validate", "reload", "validate", "reload"]);
});

test("a change of CA restarts Caddy instead of reloading it, since a reload keeps the cached certificates", async () => {
  const w = await world({ tls: { ca: "letsencrypt-staging" } });
  await w.caddy.router.apply(app());
  w.setSettings({ tls: { ca: "letsencrypt" } });
  expect(await w.caddy.republish()).toEqual({ published: true });
  expect(w.control.restarts).toBe(1);
  expect(w.verbs()).toEqual(["validate", "reload", "validate"]);
  // Nothing changed since: republishing builds nothing.
  expect(await w.caddy.republish()).toEqual({ published: false });
});

test("republishing rewrites every owned block with the current site lines and reloads once", async () => {
  const w = await world({
    site: ["import cloudflare", "import backend_errors"],
  });
  await w.caddy.router.apply(app());
  w.setSettings({ site: ["import backend_errors"] });
  await w.caddy.republish();
  const routes = await w.routes();
  expect(routes).not.toContain("import cloudflare");
  expect(routes).toContain("  import backend_errors\n");
  expect(await w.file("caddy", "current", "routes.caddy")).toBe(routes);
  expect(w.control.restarts).toBe(0);
});

test("the custom files are applied only by an explicit apply; a rejected one changes nothing and Rig's routes keep serving", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  await writeFile(
    join(w.root, "proxy", "custom.caddy"),
    "other.example.test {\n\trespond ok\n}\n",
  );
  // A route change keeps using the accepted copies.
  await w.caddy.router.apply(app("127.0.0.1:3002"));
  expect(await w.file("caddy", "current", "custom.caddy")).not.toContain(
    "other.example.test",
  );
  await w.caddy.applyCustom();
  expect(await w.file("caddy", "current", "custom.caddy")).toContain(
    "other.example.test",
  );
  const accepted = await w.current();

  await writeFile(
    join(w.root, "proxy", "custom.caddy"),
    "broken.example.test {\n\tnot_a_directive\n}\n",
  );
  w.failures.validate =
    "Error: adapting config using caddyfile: custom.caddy:2: unrecognized directive: not_a_directive";
  await expect(w.caddy.applyCustom()).rejects.toMatchObject({
    code: "PROXY_CUSTOM_INVALID",
    message: expect.stringContaining("unrecognized directive"),
  });
  expect(await w.current()).toBe(accepted);
  expect(await w.file("caddy", "current", "custom.caddy")).toContain(
    "other.example.test",
  );
});

test("a Rig route whose hostname an accepted custom site serves is refused, naming the custom file", async () => {
  const w = await world();
  await mkdir(join(w.root, "proxy"), { recursive: true });
  await writeFile(
    join(w.root, "proxy", "custom.caddy"),
    "app.example.test {\n\trespond custom\n}\n",
  );
  await w.caddy.applyCustom();
  await expect(w.caddy.router.apply(app())).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    details: { owner: join(w.root, "proxy", "custom.caddy") },
  });
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
  // Caddy's own CA needs no token.
  const internal = await world({ tls: { ca: "internal" } }, null);
  await internal.caddy.router.apply(app());
  expect(await internal.current()).toBe("g001");
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

test("custom global options may not set what Rig sets itself, such as the admin socket, storage or ports", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const accepted = await w.current();
  for (const [text, option, line] of [
    ["# moved\nadmin localhost:2999\n", "admin", 2],
    [
      "servers {\n\ttimeouts {\n\t\tidle 2m\n\t}\n}\nhttps_port 8443\n",
      "https_port",
      6,
    ],
    ["log default {\n\tlevel DEBUG\n}\n", "log default", 1],
  ] as const) {
    await writeFile(join(w.root, "proxy", "custom-global.caddy"), text);
    await expect(w.caddy.applyCustom()).rejects.toMatchObject({
      code: "PROXY_CUSTOM_INVALID",
      message: expect.stringContaining(`:${line} sets ${option}`),
    });
    expect(await w.current()).toBe(accepted);
  }
  // Options Rig does not set are the owner's.
  await writeFile(
    join(w.root, "proxy", "custom-global.caddy"),
    "servers {\n\ttimeouts {\n\t\tidle 2m\n\t}\n}\nlog access {\n\toutput stderr\n}\n",
  );
  await w.caddy.applyCustom();
  expect(await w.file("caddy", "current", "custom-global.caddy")).toContain(
    "idle 2m",
  );
});

test("an apply takes the current site lines too, and a failed rollback reload is reported, not claimed", async () => {
  const w = await world({ site: ["import cloudflare"] });
  await w.caddy.router.apply(app());
  w.setSettings({ site: [] });
  await w.caddy.applyCustom();
  expect(await w.routes()).not.toContain("import cloudflare");

  w.failures.reload = "Error: loading new config: boom";
  const error = await w.caddy.router
    .apply(app("127.0.0.1:3002"))
    .catch((caught) => caught);
  expect(error).toMatchObject({
    code: "ROUTE_RELOAD",
    details: { rollbackReloaded: false },
  });
  expect(error.message).not.toContain("was restored");
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
