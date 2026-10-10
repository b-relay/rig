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
  /** The owner's sites and snippets. Rig creates it once and never rewrites it. */
  readonly custom: string;
  /** The custom global options file an earlier Rig read; no longer read, and refused while it holds anything. */
  readonly retiredCustomGlobal: string;
  /** The DNS provider's API token, mode 0600. */
  readonly token: string;
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
    custom: join(root, "proxy", "custom.caddy"),
    retiredCustomGlobal: join(root, "proxy", "custom-global.caddy"),
    token: join(root, "auth", "acme-dns.token"),
  };
}
/** The files of one generation; every import of its main file names one of them, so a generation never mixes with another. */
export function generationFiles(directory: string) {
  return {
    main: join(directory, "Caddyfile"),
    routes: join(directory, "routes.caddy"),
    custom: join(directory, "custom.caddy"),
    /** Rig's main file with Rig's routes alone (no `site` lines, no custom sites), adapted to check the full one against. */
    base: join(directory, "base.Caddyfile"),
    baseRoutes: join(directory, "base-routes.caddy"),
    empty: join(directory, "empty.caddy"),
    metadata: join(directory, "generation.json"),
    /** `caddy adapt` of the main file: what a running Caddy reports at GET /config/ once it serves this generation. */
    adapted: join(directory, "adapted.json"),
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
  /** Every hostname served, Rig's and the custom sites', for the wildcard certificates. */
  readonly hostnames: readonly string[];
  /** The route and custom files to import; the generation's own by default. The allowlist's base imports Rig's routes
   * without their site lines and an empty custom file. */
  readonly imports?: { readonly routes: string; readonly custom: string };
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
  const parents =
    settings.tls.certificates === "wildcard"
      ? wildcardParents(input.hostnames)
      : [];
  const imports = input.imports ?? {
    routes: files.routes,
    custom: files.custom,
  };
  return [
    `# Generated by Rig from Host config. Do not edit: your sites go in ${paths.custom}.`,
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
    "}",
    `import ${imports.custom}`,
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
    `import ${imports.routes}`,
    "",
  ].join("\n");
}

/** One thing in the custom file that Rig refuses before Caddy reads it. */
export interface CustomFileProblem {
  readonly line: number;
  readonly problem: string;
}
/** A site address the custom file may use: a bare hostname, with no scheme, port, path or wildcard. */
const BARE_HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;
/** Early, friendly errors for the custom file, by line: an `import` of anything but a snippet the file defines, which would
 * read another file, a `{file.*}` placeholder, and a site address that is not a bare hostname. The authority is the
 * allowlist on the adapted JSON (`configProblems`) and the site inventory Caddy adapts; these only say it sooner and in the
 * file's own terms. */
export function customFileProblems(sites: string): CustomFileProblem[] {
  const snippets = new Set(
    [...sites.matchAll(/^\s*\(([^()\s]+)\)\s*\{/gm)].map((m) => m[1]!),
  );
  const problems: CustomFileProblem[] = [];
  let depth = 0;
  sites.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    // Caddyfile tokens may be quoted with double quotes or backticks.
    const unquote = (word: string) => word.replace(/^["`]|["`]$/g, "");
    const words = line.split(/\s+/).map(unquote);
    if (line.includes("{file."))
      problems.push({
        line: index + 1,
        problem: "reads a file through a {file.*} placeholder",
      });
    if (words[0] === "import" && !snippets.has(words[1] ?? ""))
      problems.push({
        line: index + 1,
        problem: `imports ${words[1] ?? "nothing"}`,
      });
    const head = line.endsWith("{") ? line.slice(0, -1).trim() : "";
    if (depth === 0 && head && !head.startsWith("(") && words[0] !== "import")
      for (const address of head
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(unquote))
        if (!BARE_HOSTNAME.test(address))
          problems.push({
            line: index + 1,
            problem: `names the site ${address}; a custom site names a bare hostname, with no scheme, port, path or wildcard`,
          });
    for (const character of line)
      if (character === "{") depth++;
      else if (character === "}") depth = Math.max(0, depth - 1);
  });
  return problems;
}

/** The header Rig writes into the custom file it creates. */
export function customFileHeader(): string {
  return "# Your own Caddy sites, and snippets they or proxy.site lines import. Only site blocks that route hostnames to\n# loopback services, respond, set headers, rewrite or encode are accepted. Rig never rewrites this file; apply an edit\n# with rig proxy reload.\n";
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
