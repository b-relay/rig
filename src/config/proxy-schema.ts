import { z } from "zod";

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
          .optional()
          .describe(
            "Contact address for the ACME account; optional. The CA may send expiry or policy notices to it.",
          ),
        ca: z
          .union([
            z.enum(["letsencrypt", "letsencrypt-staging", "internal"]),
            z.url({ protocol: /^https$/ }),
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
    site: z
      .array(
        text.refine(
          (line) => !/[\r\n]/.test(line),
          "must be one line; put longer configuration in a snippet in proxy/custom.caddy and import it here",
        ),
      )
      .default([])
      .describe(
        "Caddy directives added inside every site block Rig writes, such as import backend_errors. They may use snippets proxy/custom.caddy defines.",
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
