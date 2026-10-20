import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostConfig } from "../../src/config";
import type { ProxySettings } from "../../src/config/proxy-schema";
import {
  createManagedCaddy,
  type CaddyJobState,
  type DashboardRouteSource,
} from "../../src/providers/managed-caddy";
import {
  bareHostname,
  type PublishedDashboard,
} from "../../src/domain/managed-proxy";
import { routeFileHostnames } from "../../src/providers/route-file";
import type { CommandRunner } from "../../src/providers/contracts";

export const TOKEN = "Syn_thetic-Token-0123456789abcdefABCDEF";

/** A stand-in for `caddy adapt`, shaped as Caddy's JSON is (checked against 2.10.2): Rig's sites and proxy.routes as
 * routes of one HTTPS server, the route file's text as the Rig routes' body, so two generations with the same content
 * adapt alike. Values in the main file are quoted, as Rig writes them. */
export async function fakeAdapt(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  const imported = /^import "?([^"\s]+)"?$/m.exec(text)?.[1];
  const routesText = imported
    ? await readFile(imported, "utf8").catch(() => "")
    : "";
  const field = (pattern: RegExp) => pattern.exec(text)?.[1];
  const https = Number(field(/https_port "?(\d+)"?/));
  const routes = [
    ...routeFileHostnames(routesText).map((host) => ({
      match: [{ host: [bareHostname(host)] }],
      handle: [{ handler: "static_response", body: routesText }],
      terminal: true,
    })),
    ...[
      ...text.matchAll(
        /^"?([^"\s]+)"? \{\n\t(?:reverse_proxy "?([^"\s]+)"?|respond 503)\n\}$/gm,
      ),
    ].map((match) => ({
      match: [{ host: [match[1]!] }],
      handle: [
        {
          handler: "subroute",
          routes: [
            {
              handle: [
                match[2] === undefined
                  ? { handler: "static_response", status_code: 503 }
                  : {
                      handler: "reverse_proxy",
                      upstreams: [{ dial: match[2] }],
                    },
              ],
            },
          ],
        },
      ],
      terminal: true,
    })),
  ];
  return {
    admin: { listen: field(/admin "([^"]+)"/) },
    storage: {
      module: "file_system",
      root: field(/storage file_system "?([^"\s]+)"?/),
    },
    apps: {
      http: {
        http_port: Number(field(/http_port "?(\d+)"?/)),
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
                  : {
                      module: "acme",
                      ca: field(/cert_issuer acme "?([^"\s]+)"?/),
                    },
              ],
            },
          ],
        },
      },
    },
  };
}

/** A managed Caddy over a temporary root whose caddy, job and admin socket are scripted. `caddy.loaded` is what the fake
 * Caddy runs; a reload or restart loads a generation as real Caddy would. The caller removes `root`. */
export async function managedCaddyWorld(
  proxy: Record<string, unknown> = {},
  token: string | null = TOKEN,
  /** The dashboard's route as a rigd would ask for it (ManagedCaddyOptions.dashboard); a function stands for a route
   * rigd confirms as it asks for it. */
  dashboard?: (() => PublishedDashboard | undefined) | DashboardRouteSource,
) {
  const root = await mkdtemp(join(tmpdir(), "rig-managed-"));
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
    /** Runs each time the router reads Host config's proxy settings, before it gets them. */
    beforeSettings: undefined as undefined | (() => Promise<void>),
    /** Runs each time the fake Caddy loads a configuration, with it, before the load is reported done. */
    onLoad: undefined as undefined | ((config: unknown) => Promise<void>),
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
    if (verb === "reload" && !control.ignoreReload) {
      control.loaded = command[3]!.endsWith(".json")
        ? JSON.parse(await readFile(command[3]!, "utf8"))
        : await fakeAdapt(command[3]!);
      await control.onLoad?.(control.loaded);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  let id = 0;
  const caddy = createManagedCaddy({
    root,
    settings: async () => {
      await control.beforeSettings?.();
      return settings;
    },
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
        await control.onLoad?.(control.loaded);
      },
    },
    admin: {
      reachable: async () => control.reachable,
      config: async () => (control.reachable ? control.loaded : undefined),
    },
    ...(dashboard
      ? {
          dashboard:
            typeof dashboard === "function"
              ? { current: dashboard, confirmed: async () => dashboard() }
              : dashboard,
        }
      : {}),
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
    /** What the fake Caddy does with requests for `hostname` beside Rig's route file (see hostAnswer). */
    servedHost: (hostname: string) => hostAnswer(control.loaded, hostname),
  };
}
/** What `config` (Caddy's JSON as the fake adapts it) does with requests for `hostname` outside Rig's route file: the
 * upstream it dials, "withheld" for a 503 reply, or undefined when no site serves it. */
export function hostAnswer(
  config: unknown,
  hostname: string,
): string | undefined {
  type Handler = {
    handler?: string;
    upstreams?: { dial: string }[];
    routes?: { handle?: Handler[] }[];
  };
  const servers = (
    config as {
      apps?: {
        http?: {
          servers?: Record<
            string,
            {
              routes?: {
                match?: { host?: string[] }[];
                handle?: Handler[];
              }[];
            }
          >;
        };
      };
    }
  )?.apps?.http?.servers;
  for (const server of Object.values(servers ?? {}))
    for (const route of server.routes ?? []) {
      if (!route.match?.some((match) => match.host?.includes(hostname)))
        continue;
      const handler = route.handle?.[0]?.routes?.[0]?.handle?.[0];
      if (handler?.handler === "reverse_proxy")
        return handler.upstreams?.[0]?.dial;
      if (handler?.handler === "static_response") return "withheld";
    }
  return undefined;
}
