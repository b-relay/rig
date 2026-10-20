import { createHash } from "node:crypto";
import { join } from "node:path";
import { RigError } from "./errors";
import { caddyValue, checkCaddyValue } from "./caddy-value";
import { NAMED_CAS, type ProxySettings } from "../config/proxy-schema";
import { routeUpstream } from "./route-upstream";

/** Where Rig's Caddy and its configuration live under the Rig root (ADR 0014). */
export interface ProxyPaths {
  /** Directory of everything Caddy-owned: generations, storage, binary, socket, logs. */
  readonly caddy: string;
  /** One directory per config generation. */
  readonly generations: string;
  /** Symlink to the current generation; renamed into place, so switching is atomic. */
  readonly current: string;
  /** The file the Caddy job runs: the current generation's adapted JSON, frozen when it was validated, so a generation never
   * re-reads a Caddyfile, an import or an environment variable after Rig checked it. */
  readonly entry: string;
  /** Caddy storage: ACME account and certificates. Kept across reinstalls. */
  readonly data: string;
  /** Directory of immutable binary copies and the `caddy` symlink the job runs. */
  readonly bin: string;
  readonly binary: string;
  readonly socket: string;
  /** Caddy's own log. */
  readonly log: string;
  /** Output of the job itself, where a Caddy that cannot start says why. */
  readonly jobLog: string;
  /** Pid record of a Caddy run as a detached process (`process` mode). */
  readonly processRecord: string;
  /** Rig's marked route blocks: the source of truth for routes. */
  readonly routes: string;
  /** Custom Caddy files an earlier build of Rig read (custom.caddy, custom-global.caddy). Rig no longer reads them; doctor
   * reports one left on disk, since its routes belong under proxy.routes now. */
  readonly retiredCustomFiles: readonly string[];
  /** The DNS provider's API token, mode 0600. */
  readonly token: string;
  /** Host config Rig last refused, with why; removed once Host config is accepted. */
  readonly rejectedSettings: string;
  /** Written by a rigd once nothing it sent can reach Caddy any more (it stopped in order), and taken by the next as it
   * starts; without it, Caddy may still hold a configuration an earlier rigd sent, and is restarted. */
  readonly cleanStop: string;
  /** Written durably before Rig restarts Caddy's job, and removed durably once Caddy answers again or is confirmed to serve
   * what Rig meant it to (a rollback to a Caddy that never stopped), or once its owner removes the job: while it exists,
   * Caddy may be stopped by a restart Rig did not see through (cancelled, or failed with its rollback), not by its owner, so
   * recovery starts it again. */
  readonly restore: string;
}
export function proxyPaths(root: string): ProxyPaths {
  const caddy = join(root, "caddy");
  return {
    caddy,
    generations: join(caddy, "generations"),
    current: join(caddy, "current"),
    entry: join(caddy, "current", "adapted.json"),
    data: join(caddy, "data"),
    bin: join(caddy, "bin"),
    binary: join(caddy, "bin", "caddy"),
    socket: join(caddy, "admin.sock"),
    log: join(caddy, "caddy.log"),
    jobLog: join(caddy, "launchd.log"),
    processRecord: join(caddy, "process.json"),
    routes: join(root, "proxy", "Caddyfile"),
    retiredCustomFiles: [
      join(root, "proxy", "custom.caddy"),
      join(root, "proxy", "custom-global.caddy"),
    ],
    token: join(root, "auth", "acme-dns.token"),
    rejectedSettings: join(caddy, "settings-rejected.json"),
    cleanStop: join(caddy, "clean-stop.json"),
    restore: join(caddy, "restore.json"),
  };
}
/** The files of one generation; every import of its main file names one of them, so a generation never mixes with another. */
export function generationFiles(directory: string) {
  return {
    main: join(directory, "Caddyfile"),
    routes: join(directory, "routes.caddy"),
    metadata: join(directory, "generation.json"),
    /** `caddy adapt` of the main file: what a running Caddy reports at GET /config/ once it serves this generation. */
    adapted: join(directory, "adapted.json"),
  };
}

/** The proxy fields Caddy never reads: `dns` is read by rigd's DNS records at every request (ADR 0018), so changing it is
 * never a pending proxy setting and needs no reload. */
export const CADDY_IGNORED_FIELDS: ReadonlySet<string> = new Set(["dns"]);
/** A digest of the proxy settings Caddy is rendered from, as each generation records them. Fields Caddy ignores are left
 * out, so a digest recorded before they existed still matches. */
export function settingsDigest(settings: ProxySettings): string {
  const rendered = Object.fromEntries(
    Object.entries(settings).filter(
      ([field]) => !CADDY_IGNORED_FIELDS.has(field),
    ),
  );
  return createHash("sha256").update(JSON.stringify(rendered)).digest("hex");
}
/** The ACME directory URL `tls.ca` names, or undefined for `internal`. */
export function caDirectory(
  ca: ProxySettings["tls"]["ca"],
): string | undefined {
  if (ca === "internal") return undefined;
  return ca in NAMED_CAS ? NAMED_CAS[ca as keyof typeof NAMED_CAS] : ca;
}

/** The bare hostname Caddy serves for a site address, or undefined when the site has no certificate: plain `http://`, an IP
 * address, localhost, or a wildcard (whose certificate is its own). */
export function certificateName(address: string): string | undefined {
  if (/^http:\/\//i.test(address)) return undefined;
  const host = address
    .replace(/^https:\/\//i, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
  if (
    !host ||
    host.includes("*") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":") ||
    host === "localhost" ||
    host.endsWith(".localhost")
  )
    return undefined;
  return host;
}
/** The wildcard subjects that cover `hostnames` with one certificate per parent: `*.<hostname without its first label>`,
 * when that parent has at least two labels. Sorted and without duplicates. */
export function wildcardParents(hostnames: readonly string[]): string[] {
  const parents = new Set<string>();
  for (const address of hostnames) {
    const host = certificateName(address);
    if (!host) continue;
    const parent = host.split(".").slice(1);
    if (parent.length >= 2) parents.add(`*.${parent.join(".")}`);
  }
  return [...parents].sort();
}

/** The bare hostname of a site address, as Caddy matches requests to it: no scheme, no port, lowercase. Two addresses with
 * one bare hostname are one name to a client, whatever port or scheme each is written with. */
export function bareHostname(address: string): string {
  return address
    .replace(/^https?:\/\//i, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}
/** One of the owner's own routes from `proxy.routes`, or the dashboard's: a hostname outside any Project and the loopback
 * address it reaches. */
export interface HostRoute {
  readonly hostname: string;
  /** `127.0.0.1:<port>` or `localhost:<port>`; null while it is withheld, answered with Rig's not-running reply. */
  readonly upstream: string | null;
}
/** The dashboard's route as Rig's Caddy serves it: its domain to `port` on 127.0.0.1 while rigd has verified that its own
 * dashboard listens there, and withheld (`port` null) otherwise. The verified port is the route's identity: no other
 * source names the dashboard's upstream. */
export interface PublishedDashboard {
  readonly domain: string;
  readonly port: number | null;
}
/** `proxy.routes` as Rig serves it, with the dashboard's route when there is one, sorted by hostname: a bare port means that
 * port on 127.0.0.1. Settings an older rigd recorded may hold the dashboard's domain among `proxy.routes`; the dashboard's
 * route as rigd asks for it now replaces that entry. */
export function hostRoutes(
  settings: ProxySettings,
  dashboard?: PublishedDashboard,
): HostRoute[] {
  return [
    ...Object.entries(settings.routes)
      .filter(([hostname]) => hostname !== dashboard?.domain)
      .map(([hostname, upstream]) => ({
        hostname,
        upstream:
          typeof upstream === "number" ? routeUpstream(upstream) : upstream,
      })),
    ...(dashboard
      ? [
          {
            hostname: dashboard.domain,
            upstream:
              dashboard.port === null ? null : routeUpstream(dashboard.port),
          },
        ]
      : []),
  ].sort((a, b) => a.hostname.localeCompare(b.hostname));
}

/** What a generation's main file is rendered from. */
export interface MainCaddyfileInput {
  readonly settings: ProxySettings;
  readonly paths: ProxyPaths;
  /** The generation directory; every import names a file inside it. */
  readonly generation: string;
  /** Every hostname Rig's route file serves; with `proxy.routes`, what the wildcard certificates cover. */
  readonly hostnames: readonly string[];
  /** The dashboard's route, served beside `proxy.routes` (see hostRoutes). */
  readonly dashboard?: PublishedDashboard;
}
/** The main Caddyfile of one generation. Pure: the same input renders the same text. Every value from config or the Rig
 * root reaches it through `caddyValue`, checked against its field's shape and quoted, so no value can carry Caddyfile
 * syntax: not a placeholder, an `{$ENV}` expansion, a directive or a comment. */
export function renderMainCaddyfile(input: MainCaddyfileInput): string {
  const { settings, paths } = input;
  const files = generationFiles(input.generation);
  // macOS limits a Unix socket path to 104 bytes, so a deep Rig root cannot hold Caddy's admin socket.
  if (Buffer.byteLength(paths.socket) > 103)
    throw new RigError(
      "PROXY_PATH",
      `Caddy's admin socket path ${paths.socket} is longer than macOS allows (103 bytes).`,
      "Use a Rig root with a shorter path.",
      { path: paths.socket },
    );
  const local = settings.ports.http >= 1024 && settings.ports.https >= 1024;
  const directory = caDirectory(settings.tls.ca);
  const issuer = directory
    ? [
        `\tcert_issuer acme ${caddyValue("url", directory)} {`,
        // A placeholder Rig itself writes: the token is read from its file when Caddy provisions the DNS module.
        `\t\tdns ${caddyValue("module", settings.tls.dns)} "{file.${checkCaddyValue("path", paths.token)}}"`,
        `\t\tresolvers ${settings.tls.resolvers.map((ip) => caddyValue("ip", ip)).join(" ")}`,
        "\t}",
      ]
    : ["\tlocal_certs", "\tskip_install_trust"];
  const owned = hostRoutes(settings, input.dashboard);
  const parents =
    settings.tls.certificates === "wildcard"
      ? wildcardParents([
          ...input.hostnames,
          ...owned.map((route) => route.hostname),
        ])
      : [];
  return [
    "# Generated by Rig from Host config. Do not edit: your own hostnames go under proxy.routes in config.yaml.",
    "{",
    `\tadmin ${caddyValue("admin", `unix/${paths.socket}|0600`)}`,
    "\tpersist_config off",
    `\tstorage file_system ${caddyValue("path", paths.data)}`,
    `\thttp_port ${caddyValue("port", settings.ports.http)}`,
    `\thttps_port ${caddyValue("port", settings.ports.https)}`,
    // Ports from 1024 up are for staging and tests, and stay on this machine.
    ...(local ? ["\tdefault_bind 127.0.0.1"] : []),
    ...(settings.tls.email
      ? [`\temail ${caddyValue("email", settings.tls.email)}`]
      : []),
    ...issuer,
    "\tlog default {",
    `\t\toutput file ${caddyValue("path", paths.log)} {`,
    "\t\t\troll_size 10MiB",
    "\t\t\troll_keep 5",
    "\t\t}",
    "\t}",
    "}",
    ...(parents.length
      ? [
          "",
          "# One certificate per parent of a served hostname. A name below one of these that no site serves is refused.",
          `${parents.map((parent) => caddyValue("wildcard", parent)).join(" ")} {`,
          "\tabort",
          "}",
        ]
      : []),
    "",
    `import ${caddyValue("path", files.routes)}`,
    // Validated by the schema and again here: a lowercase hostname and a loopback address, nothing else. A withheld one
    // answers 503, which Rig's down page words (withDownPages).
    ...owned.flatMap((route) => [
      "",
      `${caddyValue("hostname", route.hostname)} {`,
      route.upstream === null
        ? "\trespond 503"
        : `\treverse_proxy ${caddyValue("upstream", route.upstream)}`,
      "}",
    ]),
    "",
  ].join("\n");
}

/** The token forms caddy-dns/cloudflare v0.2.4 accepts (`validCloudflareToken`): a classic API token of 35 to 50 letters,
 * digits, '_' or '-', or a user (cfut_) or account (cfat_) token. The plugin quotes any other value in its error, so Rig
 * accepts exactly these and nothing it would reject. */
export const CLOUDFLARE_TOKEN_FORMS = [
  /^[A-Za-z0-9_-]{35,50}$/,
  /^cf(ut|at)_[A-Za-z0-9_-]{32,256}$/,
] as const;
/** A DNS provider API token as Rig stores it: trimmed of surrounding whitespace, then one of `CLOUDFLARE_TOKEN_FORMS`. */
export function normalizeToken(input: string): string {
  const token = input.trim();
  if (!CLOUDFLARE_TOKEN_FORMS.some((form) => form.test(token)))
    throw new RigError(
      "PROXY_TOKEN",
      "The DNS API token is malformed: Cloudflare API tokens are 35 to 50 letters, digits, '_' or '-', or start with cfut_ or cfat_.",
      "Copy the token again from the Cloudflare dashboard, without spaces or quotes, and pipe it to rig proxy token.",
    );
  return token;
}
/** `text` with every secret, and anything Caddy quotes after the word token, replaced by [redacted]. Every Caddy output Rig
 * keeps or shows passes through here. */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let redacted = text;
  for (const secret of secrets)
    if (secret.trim().length >= 8)
      redacted = redacted.split(secret).join("[redacted]");
  return redacted.replace(
    /(token[^'"\n]{0,40}?['"`])([^'"`\n]*)(['"`])/gi,
    (_, open: string, value: string, close: string) =>
      value === "[redacted]"
        ? `${open}${value}${close}`
        : `${open}[redacted]${close}`,
  );
}
