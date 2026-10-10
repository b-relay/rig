import { join } from "node:path";
import { RigError } from "./errors";
import { NAMED_CAS, type ProxySettings } from "../config/proxy-schema";

/** Where Rig's Caddy and its configuration live under the Rig root (ADR 0014). */
export interface ProxyPaths {
  /** Directory of everything Caddy-owned: generations, storage, binary, socket, logs. */
  readonly caddy: string;
  /** One directory per config generation. */
  readonly generations: string;
  /** Symlink to the current generation; renamed into place, so switching is atomic. */
  readonly current: string;
  /** The file the Caddy job runs: the current generation's main Caddyfile. */
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
  /** The owner's sites and snippets. Rig creates it once and never rewrites it. */
  readonly custom: string;
  /** The owner's global options. Rig creates it once and never rewrites it. */
  readonly customGlobal: string;
  /** The DNS provider's API token, mode 0600. */
  readonly token: string;
}
export function proxyPaths(root: string): ProxyPaths {
  const caddy = join(root, "caddy");
  return {
    caddy,
    generations: join(caddy, "generations"),
    current: join(caddy, "current"),
    entry: join(caddy, "current", "Caddyfile"),
    data: join(caddy, "data"),
    bin: join(caddy, "bin"),
    binary: join(caddy, "bin", "caddy"),
    socket: join(caddy, "admin.sock"),
    log: join(caddy, "caddy.log"),
    jobLog: join(caddy, "launchd.log"),
    processRecord: join(caddy, "process.json"),
    routes: join(root, "proxy", "Caddyfile"),
    custom: join(root, "proxy", "custom.caddy"),
    customGlobal: join(root, "proxy", "custom-global.caddy"),
    token: join(root, "auth", "acme-dns.token"),
  };
}
/** The files of one generation; every import of its main file names one of them, so a generation never mixes with another. */
export function generationFiles(directory: string) {
  return {
    main: join(directory, "Caddyfile"),
    routes: join(directory, "routes.caddy"),
    custom: join(directory, "custom.caddy"),
    customGlobal: join(directory, "custom-global.caddy"),
    metadata: join(directory, "generation.json"),
  };
}
/** Caddyfile tokens Rig writes unquoted must not need quoting, so a root with whitespace, quotes or braces is refused. */
export function assertPlainPath(path: string): void {
  if (/[\s"'{}#\\]/.test(path))
    throw new RigError(
      "PROXY_PATH",
      `Rig's Caddy cannot use ${path}: it contains whitespace, quotes, braces or '#'.`,
      "Use a Rig root whose path has none of these characters.",
      { path },
    );
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

/** Every site address a Caddyfile declares at its top level, in order, read from its text: the addresses before a `{` at
 * brace depth 0, skipping the global options block and snippet definitions. Comments are ignored. */
export function caddyfileSites(text: string): string[] {
  const sites: string[] = [];
  let depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    if (depth === 0 && line.endsWith("{")) {
      const head = line.slice(0, -1).trim();
      if (head && !head.startsWith("(") && !head.startsWith("import "))
        sites.push(...head.split(/[\s,]+/).filter(Boolean));
    }
    for (const character of line)
      if (character === "{") depth++;
      else if (character === "}") depth = Math.max(0, depth - 1);
  }
  return sites;
}

/** What a generation's main file is rendered from. */
export interface MainCaddyfileInput {
  readonly settings: ProxySettings;
  readonly paths: ProxyPaths;
  /** The generation directory; every import names a file inside it. */
  readonly generation: string;
  /** Hostnames Rig's routes serve, for the wildcard certificates. */
  readonly hostnames: readonly string[];
  /** Site addresses the custom file declares: a wildcard it serves is left out of Rig's own block. */
  readonly customSites: readonly string[];
}
/** The main Caddyfile of one generation. Pure: the same input renders the same text. */
export function renderMainCaddyfile(input: MainCaddyfileInput): string {
  const { settings, paths } = input;
  const files = generationFiles(input.generation);
  for (const path of [paths.caddy, input.generation, paths.token])
    assertPlainPath(path);
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
        `\tcert_issuer acme ${directory} {`,
        `\t\tdns ${settings.tls.dns} {file.${paths.token}}`,
        `\t\tresolvers ${settings.tls.resolvers.join(" ")}`,
        "\t}",
      ]
    : ["\tlocal_certs", "\tskip_install_trust"];
  const customWildcards = new Set(
    input.customSites.map((site) =>
      site.toLowerCase().replace(/^https:\/\//, ""),
    ),
  );
  const parents =
    settings.tls.certificates === "wildcard"
      ? wildcardParents(input.hostnames).filter(
          (parent) => !customWildcards.has(parent),
        )
      : [];
  return [
    `# Generated by Rig from Host config. Do not edit: your sites go in ${paths.custom}, your global options in ${paths.customGlobal}.`,
    "{",
    `\tadmin "unix/${paths.socket}|0600"`,
    "\tpersist_config off",
    `\tstorage file_system ${paths.data}`,
    `\thttp_port ${settings.ports.http}`,
    `\thttps_port ${settings.ports.https}`,
    // Ports from 1024 up are for staging and tests, and stay on this machine.
    ...(local ? ["\tdefault_bind 127.0.0.1"] : []),
    ...(settings.tls.email ? [`\temail ${settings.tls.email}`] : []),
    ...issuer,
    "\tlog default {",
    `\t\toutput file ${paths.log} {`,
    "\t\t\troll_size 10MiB",
    "\t\t\troll_keep 5",
    "\t\t}",
    "\t}",
    `\timport ${files.customGlobal}`,
    "}",
    `import ${files.custom}`,
    ...(parents.length
      ? [
          "",
          "# One certificate per parent of a served hostname. A name below one of these that no site serves is refused.",
          `${parents.join(", ")} {`,
          "\tabort",
          "}",
        ]
      : []),
    "",
    `import ${files.routes}`,
    "",
  ].join("\n");
}

/** Global options Rig renders itself. Caddy lets a later one win, so one in the owner's global options could move the admin
 * API off its private socket, the storage or the listeners, and take the proxy away from Rig. */
export const PROTECTED_GLOBAL_OPTIONS = [
  "admin",
  "persist_config",
  "storage",
  "http_port",
  "https_port",
  "default_bind",
  "email",
  "cert_issuer",
  "acme_ca",
  "acme_ca_root",
  "acme_dns",
  "acme_eab",
  "local_certs",
  "skip_install_trust",
  "auto_https",
] as const;
/** Each top-level line of the owner's global options that sets an option Rig renders, with its 1-based line number. */
export function protectedGlobalOptions(
  text: string,
): { readonly option: string; readonly line: number }[] {
  const found: { option: string; line: number }[] = [];
  let depth = 0;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    const first = line.split(/\s+/)[0] ?? "";
    if (
      depth === 0 &&
      (PROTECTED_GLOBAL_OPTIONS as readonly string[]).includes(first)
    )
      found.push({ option: first, line: index + 1 });
    // A `log default` block would replace where Caddy logs, which doctor and rig proxy read.
    if (depth === 0 && /^log\s+default\b/.test(line))
      found.push({ option: "log default", line: index + 1 });
    for (const character of line)
      if (character === "{") depth++;
      else if (character === "}") depth = Math.max(0, depth - 1);
  });
  return found;
}

/** The header Rig writes into a custom file it creates. */
export function customFileHeader(kind: "sites" | "global"): string {
  return kind === "sites"
    ? "# Your own Caddy sites and snippets. Rig never rewrites this file; apply an edit with rig proxy reload.\n"
    : "# Your own Caddy global options, placed inside Rig's global options block. Rig never rewrites this file; apply an edit\n# with rig proxy reload.\n";
}

/** A DNS provider API token as Rig stores it: trimmed of surrounding whitespace, then only letters, digits, '_' and '-',
 * 20 to 512 characters. A token Caddy's DNS plugin rejects is quoted in its error, so a malformed one never reaches Caddy. */
export function normalizeToken(input: string): string {
  const token = input.trim();
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token))
    throw new RigError(
      "PROXY_TOKEN",
      "The DNS API token is malformed: a token has 20 to 512 letters, digits, '_' or '-' and nothing else.",
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
