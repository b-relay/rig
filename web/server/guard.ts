import { createHmac, timingSafeEqual } from "node:crypto";
import { ipv4, type TrustedClient } from "../../src/domain/trusted-clients";

export {
  parseTrustedClients,
  type TrustedClient,
} from "../../src/domain/trusted-clients";

/** Who may use the relay. The relay holds this Host's control-plane credential, so every
 * request it forwards must come from its own page, under its own name, from this Mac or a trusted
 * address, and carry a session the access key signed: being on this Mac or a trusted address is
 * never a sign-in by itself. */
export interface AccessPolicy {
  /** `host[:port]` values the site answers to, lower case; any other Host header is a DNS-rebinding attempt. */
  hosts: ReadonlySet<string>;
  /** Origins of the site's own pages, lower case. */
  origins: ReadonlySet<string>;
  /** Client addresses besides loopback that may reach the site and sign in: exact IPs or IPv4 CIDR blocks. */
  trustedClients: readonly TrustedClient[];
  /** The secret every browser signs in with. Without one, no request is admitted. */
  accessKey?: string;
  /** Set when this copy of the site is a Preview: it shows the pages but never relays, and names the host that does. */
  relaysAt?: string;
}
/** The request facts access is decided from; header names are lower case. */
export interface RequestFacts {
  method: string;
  headers: { get(name: string): string | null };
}
export type Admission =
  | {
      admitted: true;
      /** A valid session cookie, or a client about to present the key. */
      by: "session" | "signingIn";
    }
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

const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
/** Pure: whether one client address is loopback or named by the trusted list, so it may reach the site at all. */
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
export const SESSION_COOKIE = "rig_session";
/** How long a sign-in lasts without a visit: browsers keep no cookie longer than 400 days. Each
 * visit renews it, so a browser in use stays signed in until the access key is replaced. */
export const SESSION_SECONDS = 400 * 24 * 60 * 60;
const signature = (key: string, expires: number) =>
  createHmac("sha256", key)
    .update(`rig-session:${expires}`)
    .digest("base64url");
/** Pure: the cookie value proving a sign-in until `expires` (epoch seconds). It names no server
 * state: replacing the access key ends every session. */
export const sessionValue = (key: string, expires: number): string =>
  `${expires}.${signature(key, expires)}`;
/** Pure: the cookie that signs a browser in from `now` (epoch milliseconds), as a Set-Cookie
 * header and as the attributes a framework cookie jar takes. Every page reads rigd, so it covers the whole site.
 * `secure` holds it to HTTPS, as the published name is served; the loopback address is plain HTTP, which never
 * leaves this Mac, and a browser may keep no Secure cookie for it.
 * SameSite=Lax, not Strict: a browser sends a Strict cookie only on navigations started from this site, so opening
 * the dashboard from a home-screen icon, a bookmark or a link in another app arrived without it and landed on the
 * sign-in page. Lax still withholds it from another site's POSTs, and every change here is a POST (a Server Action,
 * which Next also refuses from another origin); the GET routes only read. */
export function sessionCookie(key: string, now: number, secure: boolean) {
  const value = sessionValue(key, Math.floor(now / 1000) + SESSION_SECONDS);
  return {
    name: SESSION_COOKIE,
    value,
    maxAge: SESSION_SECONDS,
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    header: `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`,
  };
}
/** Pure: whether a request reached the site under its loopback address, which is plain HTTP, rather than the
 * published name Caddy serves over HTTPS. */
export const loopbackHost = (host: string | null): boolean =>
  /^(?:127\.0\.0\.1|localhost):\d+$/i.test(host ?? "");
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
/** Pure: decides one request. The server listens on loopback only, so a request without
 * X-Forwarded-For came from this machine; Caddy replaces that header with the address it saw.
 * Where a request came from only decides whether it may reach the site at all; reading or driving
 * rigd always takes a session. Every page reads rigd and every Server Action drives it, so pages
 * and actions are decided alike. */
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
  // A link from another site opens the dashboard like a bookmark does; anything else from
  // elsewhere (a fetch, a form, an embedded resource) is a forgery attempt.
  const site = request.headers.get("sec-fetch-site");
  const navigation =
    request.method === "GET" &&
    request.headers.get("sec-fetch-mode") === "navigate";
  if (site && site !== "same-origin" && site !== "none" && !navigation)
    return refused(
      403,
      "ORIGIN",
      "Only the dashboard's own pages may call it.",
    );
  // A browser sends Origin with every POST, so a change without one did not come from a page.
  if (request.method === "POST" && !origin)
    return refused(
      403,
      "ORIGIN",
      "A browser origin is required to change anything.",
    );
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
  if (!clients.every((each) => trustedClient(each, policy.trustedClients)))
    return refused(
      403,
      "CLIENT",
      "The dashboard is only available from this Mac or a trusted address.",
    );
  if (!policy.accessKey)
    return refused(
      403,
      "NO_ACCESS_KEY",
      "This copy of the dashboard has no access key file, so no browser can sign in.",
    );
  if (signedIn(request.headers.get("cookie"), policy.accessKey, moment.now))
    return { admitted: true, by: "session" };
  if (moment.signingIn) return { admitted: true, by: "signingIn" };
  return refused(401, "KEY_REQUIRED", "Sign in with this Host's access key.");
}
/** Pure: the first forwarded address that is not this Mac's, if any. */
const elsewhere = (forwardedFor: string | null): string | undefined =>
  (forwardedFor ?? "")
    .split(",")
    .map((each) => each.trim())
    .find((each) => each && !LOOPBACK.test(each));
/** Pure: whether a request came from this Mac, directly or through Rig's Caddy, by its forwarded addresses. */
export const fromThisMac = (forwardedFor: string | null): boolean =>
  elsewhere(forwardedFor) === undefined;
/** Pure: where a signed-in browser's change came from, in the words Activity records beside it: this Mac,
 * or the trusted address it came from. Every change takes a session, so this names the place, not a
 * proof of who; there are no user accounts. */
export function clientName(forwardedFor: string | null): string {
  const address = elsewhere(forwardedFor);
  if (address === undefined) return "dashboard (this Mac)";
  // Activity accepts a short, plain name; an address is digits, dots, colons and hex letters.
  const plain = address.replace(/[^0-9A-Fa-f.:]/g, "").slice(0, 45);
  return `dashboard (${plain || "trusted client"})`;
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
