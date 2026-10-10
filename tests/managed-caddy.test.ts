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
import { caddyfileSites } from "../src/domain/managed-proxy";
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

/** A stand-in for `caddy adapt`: the parts of Caddy's JSON Rig reads, plus the generation's own text, so two generations
 * with the same content adapt alike, as they do in Caddy. */
async function fakeAdapt(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  if (file.endsWith("custom.caddy")) {
    const hosts = caddyfileSites(text);
    return hosts.length
      ? {
          apps: {
            http: {
              servers: {
                srv0: {
                  listen: [":443"],
                  routes: [{ match: [{ host: hosts }] }],
                },
              },
            },
          },
        }
      : {};
  }
  const directory = file.slice(0, -"/Caddyfile".length);
  const read = (name: string) =>
    readFile(join(directory, name), "utf8").catch(() => "");
  const field = (pattern: RegExp) => pattern.exec(text)?.[1];
  return {
    admin: { listen: field(/admin "([^"]+)"/) },
    storage: {
      module: "file_system",
      root: field(/storage file_system (\S+)/),
    },
    apps: {
      http: {
        http_port: Number(field(/http_port (\d+)/)),
        https_port: Number(field(/https_port (\d+)/)),
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
    content: [
      await read("routes.caddy"),
      await read("custom.caddy"),
      await read("custom-global.caddy"),
    ].join("\n--\n"),
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
      control.loaded = await fakeAdapt(command[3]!);
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
        control.loaded = await fakeAdapt(
          join(root, "caddy", "current", "Caddyfile"),
        );
      },
    },
    admin: {
      reachable: async () => control.reachable,
      config: async () => (control.reachable ? control.loaded : undefined),
    },
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
    /** The generation the fake Caddy serves, by the route file it was given. */
    servedRoutes: () =>
      String(
        (control.loaded as { content?: string } | undefined)?.content ?? "",
      ).split("\n--\n")[0],
    verbs: () =>
      commands
        .map((command) =>
          command[1] === "adapt"
            ? command[3]!.endsWith("custom.caddy")
              ? "adapt-custom"
              : "adapt"
            : command[1],
        )
        .filter((verb) => verb !== "adapt-custom"),
  };
}

test("a route change is published as a generation: validated, adapted, switched to, then reloaded and confirmed from what Caddy runs", async () => {
  const w = await world({ site: ["import backend_errors"] });
  await w.caddy.router.apply(app());
  expect(await w.current()).toBe("g001");
  const generation = join(w.root, "caddy", "generations", "g001");
  const binary = join(w.root, "caddy", "bin", "caddy");
  expect(w.commands).toEqual([
    [
      binary,
      "adapt",
      "--config",
      join(generation + ".tmp", "custom.caddy"),
      "--adapter",
      "caddyfile",
    ],
    [
      binary,
      "validate",
      "--config",
      join(generation, "Caddyfile"),
      "--adapter",
      "caddyfile",
    ],
    [
      binary,
      "adapt",
      "--config",
      join(generation, "Caddyfile"),
      "--adapter",
      "caddyfile",
    ],
    [
      binary,
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
  expect(w.servedRoutes()).toBe(routes);
  expect(
    JSON.parse(await w.file("caddy", "generations", "g001", "adapted.json")),
  ).toEqual(w.control.loaded);
  const main = await w.file("caddy", "generations", "g001", "Caddyfile");
  expect(main).toContain(`import ${join(generation, "routes.caddy")}`);
  expect(main).toContain("*.example.test {\n\tabort\n}");
  expect(await w.file("proxy", "custom.caddy")).toContain(
    "Rig never rewrites this file",
  );
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
    site: ["import cloudflare", "import backend_errors"],
  });
  await w.caddy.router.apply(app());
  w.setSettings({ site: ["import backend_errors"] });
  await w.caddy.republish();
  const routes = await w.routes();
  expect(routes).not.toContain("import cloudflare");
  expect(routes).toContain("  import backend_errors\n");
  expect(await w.file("caddy", "current", "routes.caddy")).toBe(routes);
  expect(w.servedRoutes()).toBe(routes);
  expect(w.control.restarts).toBe(0);
});

test("the custom files are applied only by an explicit apply; a rejected one changes nothing and Rig's routes keep serving", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  await writeFile(
    join(w.root, "proxy", "custom.caddy"),
    "other.example.test {\n\trespond ok\n}\n",
  );
  await w.caddy.router.apply(app("127.0.0.1:3002"));
  expect(await w.file("caddy", "current", "custom.caddy")).not.toContain(
    "other.example.test",
  );
  await w.caddy.applyCustom();
  expect(await w.file("caddy", "current", "custom.caddy")).toContain(
    "other.example.test",
  );
  // The custom site inventory comes from Caddy's parse of the custom file, and is kept with the generation.
  expect(
    JSON.parse(await w.file("caddy", "current", "generation.json")),
  ).toMatchObject({ customSites: ["other.example.test"] });
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
});

test("custom files may not read other files: a file import, a {file.*} placeholder or certificates outside the Rig root", async () => {
  const w = await world();
  await w.caddy.router.apply(app());
  const accepted = await w.current();
  for (const [file, text, said] of [
    [
      "custom.caddy",
      "import /etc/caddy/extra.caddy\n",
      "imports /etc/caddy/extra.caddy",
    ],
    [
      "custom.caddy",
      "a.example.test {\n\timport elsewhere\n}\n",
      "imports elsewhere",
    ],
    [
      "custom.caddy",
      'a.example.test {\n\trespond "{file./etc/passwd}"\n}\n',
      "{file.*}",
    ],
    [
      "custom.caddy",
      "a.example.test {\n\ttls /etc/cert.pem /etc/key.pem\n}\n",
      "certificate files outside",
    ],
    [
      "custom-global.caddy",
      "import global-extra.caddy\n",
      "imports global-extra.caddy",
    ],
  ] as const) {
    await writeFile(join(w.root, "proxy", "custom.caddy"), "");
    await writeFile(join(w.root, "proxy", "custom-global.caddy"), "");
    await writeFile(join(w.root, "proxy", file), text);
    const error = await w.caddy.applyCustom().catch((caught) => caught);
    expect(error).toMatchObject({
      code: "PROXY_CUSTOM_INVALID",
      message: expect.stringContaining(said),
      hint: expect.stringContaining("Inline the snippet into custom.caddy"),
    });
    expect(await w.current()).toBe(accepted);
  }
  // A snippet the custom file defines may be imported by name, and Caddy's own CA needs no files.
  await writeFile(join(w.root, "proxy", "custom-global.caddy"), "");
  await writeFile(
    join(w.root, "proxy", "custom.caddy"),
    "(errors) {\n\thandle_errors {\n\t\trespond 502\n\t}\n}\na.example.test {\n\ttls internal {\n\t\ton_demand\n\t}\n\timport errors\n}\n",
  );
  await w.caddy.applyCustom();
  expect(await w.current()).not.toBe(accepted);
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
  await writeFile(
    join(w.root, "proxy", "custom-global.caddy"),
    "servers {\n\ttimeouts {\n\t\tidle 2m\n\t}\n}\nlog access {\n\toutput stderr\n}\n",
  );
  await w.caddy.applyCustom();
  expect(await w.file("caddy", "current", "custom-global.caddy")).toContain(
    "idle 2m",
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

test("an apply takes the current site lines too, and a failed rollback is reported, not claimed", async () => {
  const w = await world({ site: ["import cloudflare"] });
  await w.caddy.router.apply(app());
  w.setSettings({ site: [] });
  await w.caddy.applyCustom();
  expect(await w.routes()).not.toContain("import cloudflare");

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
