import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
/** One marked route block of the route file: the owner it is keyed by, as the token its markers carry, and the hostnames
 * it serves. */
export interface OwnedRouteBlock {
  /** sha256 of the owner's route key (a Target id), hex: what `# rig begin` and `# rig end` name. */
  readonly token: string;
  readonly hostnames: readonly string[];
}
/** Whether the host Caddy loads the file Rig writes routes into, decided from configuration files alone. */
export interface ProxyPublication {
  /** File that receives Rig's marked route blocks. */
  readonly proxyFile: string;
  /** Rig-owned route blocks currently in the proxy file. */
  readonly routes: number;
  /** Each complete Rig-owned block of the proxy file, with its owner's token and hostnames. */
  readonly blocks: readonly OwnedRouteBlock[];
  /** Host Caddyfile that loads the proxy file, or the first host Caddyfile found when none does. */
  readonly hostCaddyfile?: string;
  /** direct: the proxy file is a host Caddyfile; imported: a host Caddyfile imports it; unpublished: nothing loads it;
   * managed: Rig's own Caddy serves it (ADR 0014). */
  readonly state: "direct" | "imported" | "unpublished" | "managed";
}
export interface ProxyPublicationInput {
  readonly proxyFile: string;
  /** Candidate host Caddyfiles in precedence order; the first that exists is reported. */
  readonly hostCaddyfiles: readonly string[];
  /** Variables substituted into `{$VAR}` and `{env.VAR}` import placeholders. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Returns file text, or undefined when the file is absent. */
  read(file: string): Promise<string | undefined>;
}
export interface ProxyCheck {
  readonly name: "caddy-proxy";
  readonly ok: boolean;
  readonly message: string;
  readonly reason?: string;
  readonly hint?: string;
}
/** Contacts no Caddy; a host Caddyfile publishes the proxy file when it is that file or imports it. */
export async function inspectProxyPublication(
  input: ProxyPublicationInput,
): Promise<ProxyPublication> {
  const proxyFile = resolve(input.proxyFile);
  const proxyText = (await input.read(proxyFile)) ?? "";
  const routes = countOwnedRoutes(proxyText);
  const blocks = ownedRouteBlocks(proxyText);
  let first: string | undefined;
  for (const candidate of input.hostCaddyfiles) {
    const hostCaddyfile = resolve(candidate);
    const text =
      hostCaddyfile === proxyFile
        ? routes || (await input.read(hostCaddyfile)) !== undefined
          ? ""
          : undefined
        : await input.read(hostCaddyfile);
    if (text === undefined) continue;
    first ??= hostCaddyfile;
    if (hostCaddyfile === proxyFile)
      return { proxyFile, routes, blocks, hostCaddyfile, state: "direct" };
    if (
      caddyfileImports(text, dirname(hostCaddyfile), input.environment).some(
        (pattern) => importMatches(pattern, proxyFile),
      )
    )
      return { proxyFile, routes, blocks, hostCaddyfile, state: "imported" };
  }
  return {
    proxyFile,
    routes,
    blocks,
    ...(first ? { hostCaddyfile: first } : {}),
    state: "unpublished",
  };
}
/** Only published or route-free proxy files pass; inert routes are a Host problem with a one-time fix. */
export function proxyCheck(publication: ProxyPublication): ProxyCheck {
  const { proxyFile, hostCaddyfile, routes } = publication;
  if (publication.state === "managed")
    return {
      name: "caddy-proxy",
      ok: true,
      message: `Rig's own Caddy serves the routes in ${proxyFile}.`,
    };
  if (publication.state === "direct")
    return {
      name: "caddy-proxy",
      ok: true,
      message: `Rig routes are written to the host Caddyfile ${proxyFile}.`,
    };
  if (publication.state === "imported")
    return {
      name: "caddy-proxy",
      ok: true,
      message: `Host Caddyfile ${hostCaddyfile} imports Rig routes from ${proxyFile}.`,
    };
  if (routes === 0)
    return {
      name: "caddy-proxy",
      ok: true,
      message: `No routes are published; Rig writes routes to ${proxyFile}.`,
    };
  return {
    name: "caddy-proxy",
    ok: false,
    message: hostCaddyfile
      ? `Host Caddyfile ${hostCaddyfile} does not import ${proxyFile}; its ${routes} Rig route${routes === 1 ? "" : "s"} are inert.`
      : `No host Caddyfile loads ${proxyFile}; its ${routes} Rig route${routes === 1 ? "" : "s"} are inert.`,
    reason: "proxy-unpublished",
    hint: `Add "import ${proxyFile}" to the Caddyfile the running Caddy loads and reload Caddy, or set providers.caddy.host_caddyfile to that Caddyfile.`,
  };
}
/** The token a route block's markers carry for the owner keyed `key` (a Target id). */
export function routeOwnerToken(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
/** One complete marked block of a route file as it is written there: `# rig begin <token>`, a line break, its body, then
 * `# rig end <token>` and the line break after it, when there is one. */
export interface MarkedRouteBlock {
  readonly token: string;
  /** What lies between the begin marker's line and the end marker: the block's sites. */
  readonly body: string;
  /** The block's whole text, from its begin marker through the line break after its end marker. */
  readonly text: string;
}
/** A complete marked block: a begin marker, the nearest end marker of the same token, and the line break after it. */
const MARKED_BLOCK =
  /# rig begin ([0-9a-f]{64})\r?\n([\s\S]*?)# rig end \1(?:\r?\n)?/g;
/** Every complete marked block of a route file, in order. A begin marker with no end marker of its token is no block. */
export function markedRouteBlocks(text: string): MarkedRouteBlock[] {
  return [...text.matchAll(MARKED_BLOCK)].map((match) => ({
    token: match[1]!,
    body: match[2]!,
    text: match[0],
  }));
}
/** `text` with each complete marked block, the line break after it included, replaced by what `replace` makes of it, and
 * everything else as it was. */
export function replaceMarkedRouteBlocks(
  text: string,
  replace: (block: MarkedRouteBlock) => string,
): string {
  return text.replace(MARKED_BLOCK, (whole, token: string, body: string) =>
    replace({ token, body, text: whole }),
  );
}
/** The markers around the block of the owner whose token is `token`. */
export function routeMarkers(token: string): { begin: string; end: string } {
  return { begin: `# rig begin ${token}`, end: `# rig end ${token}` };
}
/** The marked block of the owner whose token is `token`, holding `sites`: rendered sites, each ending in a line break. */
export function markedRouteBlock(token: string, sites: string): string {
  const { begin, end } = routeMarkers(token);
  return `${begin}\n${sites}${end}\n`;
}
/** Every complete marked block of a route file, in order: its token and the hostnames of its site headers (the lines of the
 * block that start at column 0 and end with `{`, as Rig renders them). Incomplete markers are not a block. */
export function ownedRouteBlocks(text: string): OwnedRouteBlock[] {
  return markedRouteBlocks(text).map((block) => ({
    token: block.token,
    hostnames: [...block.body.matchAll(/^(\S+) \{\r?$/gm)].map(
      (header) => header[1]!,
    ),
  }));
}
export function countOwnedRoutes(text: string): number {
  return text
    .split("\n")
    .filter((line) => /^\s*# rig begin [0-9a-f]+\s*$/.test(line)).length;
}
/** Absolute import patterns of a Caddyfile, following Caddy's rules: relative to the file, `{$VAR}` and `{env.VAR}` from the environment. */
export function caddyfileImports(
  text: string,
  directory: string,
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  return text.split("\n").flatMap((line) => {
    const tokens = line
      .replace(/\s#.*$|^#.*$/, "")
      .trim()
      .split(/\s+/);
    if (tokens[0] !== "import" || !tokens[1]) return [];
    const pattern = tokens[1].replace(
      /\{\$([A-Za-z_][A-Za-z0-9_]*)\}|\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_, shell: string | undefined, env: string | undefined) =>
        environment[shell ?? env ?? ""] ?? "",
    );
    return [resolve(directory, pattern)];
  });
}
/** Matches a Caddy import glob (`*`, `?`, `[...]`) against one absolute file path. */
export function importMatches(pattern: string, file: string): boolean {
  if (!/[*?[]/.test(pattern)) return pattern === file;
  const expression = pattern
    .split(/([*?]|\[[^\]]*\])/)
    .map((part, index) =>
      index % 2 === 0
        ? part.replace(/[.+^${}()|\\/]/g, "\\$&")
        : part === "*"
          ? "[^/]*"
          : part === "?"
            ? "[^/]"
            : part,
    )
    .join("");
  return new RegExp(`^${expression}$`).test(file);
}
