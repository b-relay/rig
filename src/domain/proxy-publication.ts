import { dirname, resolve } from "node:path";
/** Whether the host Caddy loads the file Rig writes routes into, decided from configuration files alone. */
export interface ProxyPublication {
  /** File that receives Rig's marked route blocks. */
  readonly proxyFile: string;
  /** Rig-owned route blocks currently in the proxy file. */
  readonly routes: number;
  /** Host Caddyfile that loads the proxy file, or the first host Caddyfile found when none does. */
  readonly hostCaddyfile?: string;
  /** direct: the proxy file is a host Caddyfile; imported: a host Caddyfile imports it; unpublished: nothing loads it. */
  readonly state: "direct" | "imported" | "unpublished";
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
  const routes = countOwnedRoutes((await input.read(proxyFile)) ?? "");
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
      return { proxyFile, routes, hostCaddyfile, state: "direct" };
    if (
      caddyfileImports(text, dirname(hostCaddyfile), input.environment).some(
        (pattern) => importMatches(pattern, proxyFile),
      )
    )
      return { proxyFile, routes, hostCaddyfile, state: "imported" };
  }
  return {
    proxyFile,
    routes,
    ...(first ? { hostCaddyfile: first } : {}),
    state: "unpublished",
  };
}
/** Only published or route-free proxy files pass; inert routes are a Host problem with a one-time fix. */
export function proxyCheck(publication: ProxyPublication): ProxyCheck {
  const { proxyFile, hostCaddyfile, routes } = publication;
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
    hint: `Add "import ${proxyFile}" to the Caddyfile the running Caddy loads and reload Caddy, or set providers.caddy.hostCaddyfile to that Caddyfile.`,
  };
}
export function countOwnedRoutes(text: string): number {
  return text.split("\n").filter((line) => /^\s*# rig begin [0-9a-f]+\s*$/.test(line)).length;
}
/** Absolute import patterns of a Caddyfile, following Caddy's rules: relative to the file, `{$VAR}` and `{env.VAR}` from the environment. */
export function caddyfileImports(
  text: string,
  directory: string,
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  return text.split("\n").flatMap((line) => {
    const tokens = line.replace(/\s#.*$|^#.*$/, "").trim().split(/\s+/);
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
