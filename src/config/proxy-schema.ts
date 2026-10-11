import { z } from "zod";
import { validHostname } from "./hostname";
import { CADDY_PATTERNS } from "../domain/caddy-value";

const text = z.string().min(1);
const port = z.number().int().min(1).max(65535);

/** The ACME CAs `tls.ca` may name, with their directory URLs. `internal` issues from Caddy's own CA, for tests. */
export const NAMED_CAS = {
  letsencrypt: "https://acme-v02.api.letsencrypt.org/directory",
  "letsencrypt-staging":
    "https://acme-staging-v02.api.letsencrypt.org/directory",
} as const;

/** `proxy` in Host config: the one Caddy Rig runs, which terminates TLS and routes every hostname (ADR 0014). */
export const proxySettingsSchema = z
  .strictObject({
    caddy: text
      .refine((path) => path.startsWith("/"), "must be an absolute path")
      .describe(
        "Caddy executable that includes the DNS module (dns.providers.cloudflare), version 2.10 or later. rigd install copies it into the Rig root and runs that copy, so replacing this file changes nothing until the next rigd install.",
      ),
    ports: z
      .strictObject({
        http: port
          .default(80)
          .describe(
            "Port Caddy serves plain HTTP on, which redirects to HTTPS. Default 80.",
          ),
        https: port
          .default(443)
          .describe("Port Caddy serves HTTPS on. Default 443."),
      })
      .prefault({})
      .superRefine((ports, context) => {
        if (ports.http === ports.https)
          context.addIssue({
            code: "custom",
            message: "http and https must be different ports.",
          });
        // macOS lets a non-root process bind ports below 1024 only on every interface, while ports from 1024 up are bound to
        // 127.0.0.1; one Caddy cannot do both.
        if (ports.http < 1024 !== ports.https < 1024)
          context.addIssue({
            code: "custom",
            message:
              "Use two ports below 1024 (served on every interface) or two from 1024 up (served on 127.0.0.1 only), not one of each.",
          });
      })
      .describe(
        "Ports Caddy listens on. Below 1024 they are served on every interface, as the Host's HTTPS edge; from 1024 up only on 127.0.0.1, for staging and tests.",
      ),
    tls: z
      .strictObject({
        email: z
          .email()
          .refine(
            (email) => CADDY_PATTERNS.email.test(email),
            "must be a plain address such as ops@example.com",
          )
          .optional()
          .describe(
            "Contact address for the ACME account; optional. The CA may send expiry or policy notices to it.",
          ),
        ca: z
          .union([
            z.enum(["letsencrypt", "letsencrypt-staging", "internal"]),
            z
              .string()
              .refine(
                (url) => CADDY_PATTERNS.url.test(url),
                "must be letsencrypt, letsencrypt-staging, internal, or an https:// URL of letters, digits and . - _ ~ % / only: no placeholder, query, space or quote",
              ),
          ])
          .default("letsencrypt")
          .describe(
            "Where certificates come from: letsencrypt, letsencrypt-staging (untrusted certificates for trying the setup without spending rate limits), internal (Caddy's own CA, for tests) or an ACME directory URL. Changing it restarts Caddy.",
          ),
        dns: z
          .enum(["cloudflare"])
          .default("cloudflare")
          .describe(
            "DNS provider that answers the ACME DNS-01 challenge. Its API token is read from auth/acme-dns.token under the Rig root, which rig proxy token writes.",
          ),
        certificates: z
          .enum(["wildcard", "hostname"])
          .default("wildcard")
          .describe(
            "wildcard: one certificate for each parent of a served hostname (*.example.com covers app.example.com and its Previews). hostname: one certificate for each hostname.",
          ),
        resolvers: z
          .array(
            z.union([z.ipv4(), z.ipv6()], {
              error: "must be an IP address",
            }),
          )
          .min(1)
          .default(["1.1.1.1", "1.0.0.1"])
          .describe(
            "DNS servers Caddy asks to check that a challenge record has propagated, instead of the Host's own resolver.",
          ),
      })
      .prefault({})
      .describe("Certificates."),
    routes: z
      .record(
        z
          .string()
          .refine(
            (hostname) =>
              validHostname(hostname) && hostname === hostname.toLowerCase(),
            "must be a lowercase hostname such as grafana.example.com; schemes, ports, paths and wildcards are not allowed",
          ),
        z
          .union([
            port,
            z
              .string()
              .regex(
                /^(?:127\.0\.0\.1|localhost):\d{1,5}$/,
                "must be a port, or 127.0.0.1:<port> or localhost:<port>",
              )
              .refine(
                (address) =>
                  port.safeParse(Number(address.split(":")[1])).success,
                "must name a port from 1 to 65535",
              ),
          ])
          .describe(
            "Where requests go: a port on 127.0.0.1, such as 3000, or 127.0.0.1:<port> or localhost:<port>.",
          ),
      )
      .default({})
      .describe(
        "Your own hostnames, outside any Rig Project, each sent to a service on this Mac, such as grafana.example.com: 3000. Rig serves each with a certificate like its own and nothing but a reverse proxy to the upstream. A hostname a Target serves is refused, and a Target asking for one of these is refused as ROUTE_CONFLICT. Applied by rig proxy reload and when rigd starts; until then, and if Rig refuses it, Caddy keeps the routes it last accepted.",
      ),
    dns: z
      .strictObject({
        zones: z
          .array(
            z
              .string()
              .refine(
                (zone) =>
                  validHostname(zone) &&
                  zone === zone.toLowerCase() &&
                  zone.includes("."),
                "must be a lowercase zone name such as example.com",
              ),
          )
          .min(1)
          .optional()
          .describe(
            "The zones Rig may list and change, such as [example.com]. Without it, every zone the DNS token can see.",
          ),
        address: z
          .ipv4({ error: "must be an IPv4 address such as 100.64.0.1" })
          .refine(
            (address) =>
              !/^(?:0\.|127\.|169\.254\.|22[4-9]\.|2[3-5]\d\.)/.test(address),
            "must be an address other machines reach this Mac at: not unspecified (0.0.0.0/8), loopback (127.0.0.0/8), link-local, multicast or broadcast",
          )
          .optional()
          .describe(
            "This Mac's address for the hostname check and Point at this Mac. Without it, Rig asks Tailscale (tailscale ip -4).",
          ),
      })
      .optional()
      .describe(
        "DNS record management from rig dns and the dashboard (ADR 0018), with the same token Caddy uses (auth/acme-dns.token, which needs Zone:Zone:Read and Zone:DNS:Edit). Read at every request, so an edit needs no reload; Caddy ignores it.",
      ),
  })
  .describe(
    "Rig runs its own Caddy, which terminates TLS with ACME DNS-01 certificates and routes every hostname. Without this section Rig runs no Caddy and only writes its route file.",
  );
export type ProxySettings = z.infer<typeof proxySettingsSchema>;

/** How Rig publishes routes, decided from the Host config as written: Rig's own Caddy when `proxy` is written; otherwise
 * the route file another Caddy may import, as `providers.caddy` describes. */
export type ProxyMode = "managed" | "external";
/** The proxy mode and whether a written `providers.caddy` is ignored because `proxy` is written too. Read from the document
 * before defaults apply, since the schema fills in `providers.caddy` for every document. */
export function proxyModeOf(value: unknown): {
  mode: ProxyMode;
  externalIgnored: boolean;
} {
  const record = (input: unknown) =>
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const document = record(value);
  const managed = document?.proxy !== undefined && document.proxy !== null;
  const external = record(document?.providers)?.caddy !== undefined;
  return {
    mode: managed ? "managed" : "external",
    externalIgnored: managed && external,
  };
}
