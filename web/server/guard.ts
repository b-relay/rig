import { createHmac, timingSafeEqual } from "node:crypto";

/** Who may use the relay. The relay holds this Host's control-plane credential, so every
 * request it forwards must come from its own page, under its own name, from a trusted machine. */
export interface AccessPolicy {
  /** `host[:port]` values the site answers to, lower case; any other Host header is a DNS-rebinding attempt. */
  hosts: ReadonlySet<string>;
  /** Origins of the site's own pages, lower case. */
  origins: ReadonlySet<string>;
  /** Client addresses allowed besides loopback: exact IPs or IPv4 CIDR blocks. */
  trustedClients: readonly TrustedClient[];
  /** The secret a client outside `trustedClients` signs in with. Without one, such clients are refused outright. */
  accessKey?: string;
  /** Set when this copy of the site is a Preview: it shows the pages but never relays, and names the host that does. */
  relaysAt?: string;
}
/** One validated trusted-client entry; `bits` is 32 for a single IPv4 address. */
export type TrustedClient =
  | { kind: "block"; base: number; bits: number }
  | { kind: "exact"; address: string };
/** The request facts access is decided from; header names are lower case. */
export interface RequestFacts {
  method: string;
  headers: { get(name: string): string | null };
}
export type Admission =
  | { admitted: true }
  | {
      admitted: false;
      status: 400 | 401 | 403 | 415;
      code: string;
      message: string;
    };

const refused = (
  status: 400 | 401 | 403 | 415,
  code: string,
  message: string,
): Admission => ({ admitted: false, status, code, message });

function ipv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = value * 256 + Number(part);
  }
  return value;
}
const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
/** Pure: whether one client address is loopback or named by the trusted list. */
export function trustedClient(
  address: string,
  trusted: readonly TrustedClient[],
): boolean {
  if (LOOPBACK.test(address)) return true;
  const client = ipv4(address);
  return trusted.some((entry) => {
    if (entry.kind === "exact") return entry.address === address.toLowerCase();
    if (client === undefined) return false;
    const span = 2 ** (32 - entry.bits);
    return Math.floor(entry.base / span) === Math.floor(client / span);
  });
}
/** Pure: reads the operator's trusted-client list. A malformed entry throws rather than
 * being skipped or widened, because a typo here decides who controls the Host. */
export function parseTrustedClients(list: string): TrustedClient[] {
  return list
    .split(",")
    .map((each) => each.trim())
    .filter(Boolean)
    .map((entry): TrustedClient => {
      const block = /^([\d.]+)\/(\d{1,2})$/.exec(entry);
      const base = ipv4(block ? block[1]! : entry);
      if (block && base !== undefined && Number(block[2]) <= 32)
        return { kind: "block", base, bits: Number(block[2]) };
      if (!block && base !== undefined)
        return { kind: "block", base, bits: 32 };
      if (!block && /^[0-9a-f:]+$/i.test(entry) && entry.includes(":"))
        return { kind: "exact", address: entry.toLowerCase() };
      throw new TypeError(
        `"${entry}" is not an IP address or an IPv4 block such as 100.64.0.0/10.`,
      );
    });
}
export const SESSION_COOKIE = "rig_session";
/** How long a sign-in lasts. */
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
const signature = (key: string, expires: number) =>
  createHmac("sha256", key)
    .update(`rig-session:${expires}`)
    .digest("base64url");
/** Pure: the cookie value proving a sign-in until `expires` (epoch seconds). It names no server
 * state: replacing the access key ends every session. */
export const sessionValue = (key: string, expires: number): string =>
  `${expires}.${signature(key, expires)}`;
const sameText = (a: string, b: string): boolean => {
  const [left, right] = [Buffer.from(a), Buffer.from(b)];
  return left.length === right.length && timingSafeEqual(left, right);
};
/** Pure: whether `offered` is the access key, compared in constant time. */
export const keyMatches = (offered: string, key: string): boolean =>
  sameText(
    createHmac("sha256", "rig-key").update(offered).digest("hex"),
    createHmac("sha256", "rig-key").update(key).digest("hex"),
  );
/** Pure: whether a Cookie header carries an unexpired session signed with `key`. */
export function signedIn(
  cookies: string | null,
  key: string,
  now: number,
): boolean {
  // Any valid cookie counts: a sibling subdomain can plant a junk rig_session ahead of the real one.
  return (cookies ?? "")
    .split(";")
    .map((each) => each.trim())
    .filter((each) => each.startsWith(`${SESSION_COOKIE}=`))
    .some((each) => {
      const value = each.slice(SESSION_COOKIE.length + 1);
      const expires = Number(value.split(".")[0]);
      return (
        Number.isInteger(expires) &&
        expires * 1000 > now &&
        sameText(value, sessionValue(key, expires))
      );
    });
}
/** Headers a tunnel or a second proxy adds. Behind one, Caddy sees the tunnel's loopback
 * address for every visitor, so the client check would admit the whole internet. */
const TUNNEL_HEADERS = [
  "forwarded",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "cf-ray",
  "tailscale-user-login",
  "ngrok-trace-id",
];
/** Pure: decides one relay request. The server listens on loopback only, so a request without
 * X-Forwarded-For came from this machine; Caddy replaces that header with the address it saw. */
export function admit(
  request: RequestFacts,
  policy: AccessPolicy,
  /** `signingIn` admits a client that is about to present the key; `now` is epoch milliseconds. */
  // Without a clock every session counts as expired.
  moment: { now: number; signingIn?: boolean } = { now: Infinity },
): Admission {
  if (policy.relaysAt)
    return refused(
      403,
      "PREVIEW",
      `A Preview of this site does not control rigd. Use ${policy.relaysAt}.`,
    );
  const host = request.headers.get("host")?.toLowerCase();
  if (!host || !policy.hosts.has(host))
    return refused(403, "HOST", "This site does not answer to that host name.");
  const origin = request.headers.get("origin")?.toLowerCase();
  if (origin && !policy.origins.has(origin))
    return refused(403, "ORIGIN", "This browser origin is not allowed.");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin")
    return refused(
      403,
      "ORIGIN",
      "Only the dashboard's own pages may call it.",
    );
  if (request.method === "POST") {
    // A cross-site form cannot send JSON without a preflight this server never answers.
    const type = request.headers.get("content-type")?.split(";")[0]?.trim();
    if (type?.toLowerCase() !== "application/json")
      return refused(415, "CONTENT_TYPE", "Requests must be application/json.");
    if (!origin)
      return refused(
        403,
        "ORIGIN",
        "A browser origin is required to change anything.",
      );
  }
  if (TUNNEL_HEADERS.some((name) => request.headers.get(name) !== null))
    return refused(
      403,
      "CLIENT",
      "The dashboard is not available through a tunnel or a second proxy.",
    );
  const forwarded = request.headers.get("x-forwarded-for");
  const clients = forwarded
    ? forwarded.split(",").map((each) => each.trim())
    : [];
  if (clients.every((each) => trustedClient(each, policy.trustedClients)))
    return { admitted: true };
  if (!policy.accessKey)
    return refused(
      403,
      "CLIENT",
      "The dashboard is only available from this Mac or a trusted address.",
    );
  if (
    moment.signingIn ||
    signedIn(request.headers.get("cookie"), policy.accessKey, moment.now)
  )
    return { admitted: true };
  return refused(401, "KEY_REQUIRED", "Sign in with this Host's access key.");
}
/** Pure: the policy for a site published as `publicHost` and listening on a loopback port. */
export function accessPolicy(site: {
  publicHost?: string;
  port: number;
  trustedClients?: readonly TrustedClient[];
  /** The one published host whose dashboard controls rigd; other published hosts are Previews. */
  dashboardHost?: string;
  /** This copy relays to a sandbox rigd of its own, so a Preview may relay too: it never reaches the Host's rigd. */
  sandboxed?: boolean;
  accessKey?: string;
}): AccessPolicy {
  const local = [`127.0.0.1:${site.port}`, `localhost:${site.port}`];
  const published = site.publicHost ? [site.publicHost.toLowerCase()] : [];
  return {
    hosts: new Set([...local, ...published]),
    origins: new Set([
      ...local.map((host) => `http://${host}`),
      ...published.map((host) => `https://${host}`),
    ]),
    trustedClients: site.trustedClients ?? [],
    ...(site.accessKey ? { accessKey: site.accessKey } : {}),
    ...(!site.sandboxed &&
    site.publicHost &&
    site.dashboardHost &&
    site.publicHost.toLowerCase() !== site.dashboardHost.toLowerCase()
      ? { relaysAt: site.dashboardHost }
      : {}),
  };
}
