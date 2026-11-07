import { z } from "zod";
import { validHostname } from "./hostname";
import { parseTrustedClient } from "../domain/trusted-clients";
import { proxySettingsSchema } from "./proxy-schema";

// Host config (config.yaml under the Rig root) apart from the Project schema, so what reads only Host config loads no
// Project rules.
const text = z.string().min(1);
/** The port rigd serves the dashboard on unless Host config names another. */
export const DEFAULT_DASHBOARD_PORT = 4280;
export const hostConfigSchema = z.strictObject({
  deploy: z
    .strictObject({
      production_branch: text
        .default("main")
        .describe(
          "Production branch for a Project whose rig.yaml sets none, and the rig init default when origin/HEAD names no branch.",
        ),
      previews: z
        .strictObject({
          max: z
            .number()
            .int()
            .min(1)
            .default(25)
            .describe(
              "Most Previews one Project may have; every recorded Preview counts, running or stopped.",
            ),
          replace_policy: z
            .enum(["oldest", "reject"])
            .default("oldest")
            .describe(
              "At the limit: oldest destroys the oldest Preview to make room (incomplete deploys first, then stopped, then running); reject refuses the deploy.",
            ),
        })
        .prefault({})
        .describe("Preview limit."),
    })
    .prefault({})
    .describe("Host deployment defaults."),
  providers: z
    .strictObject({
      caddy: z
        .strictObject({
          caddyfile: text
            .optional()
            .describe(
              "File Rig writes its marked route blocks into; defaults to proxy/Caddyfile under the Rig state directory.",
            ),
          host_caddyfile: text
            .optional()
            .describe(
              "Caddyfile the running Caddy loads; it must be the route file or import it. Defaults to the first of /usr/local/etc/Caddyfile, /opt/homebrew/etc/Caddyfile, /etc/caddy/Caddyfile that exists.",
            ),
          extra_config: z
            .array(text)
            .default([])
            .describe(
              "Extra trusted Caddy directives added inside every site block Rig writes, such as import cloudflare. They may use snippets the Host Caddyfile defines once it imports the route file.",
            ),
          reload: z
            .strictObject({
              mode: z
                .enum(["manual", "command"])
                .default("manual")
                .describe(
                  "manual: Rig writes the route file and you reload Caddy. command: Rig runs the reload command after each route change and restores the previous routes when it fails.",
                ),
              command: text
                .optional()
                .describe(
                  "Host Caddy reload command; required when mode is command.",
                ),
            })
            .superRefine((reload, context) => {
              if (reload.mode === "command" && !reload.command?.trim())
                context.addIssue({
                  code: "custom",
                  path: ["command"],
                  message:
                    "Command reload mode requires an explicit nonblank command.",
                });
            })
            .prefault({})
            .describe("Reload behavior."),
        })
        .prefault({})
        .describe(
          "Caddy provider settings, read as each route change begins, so an edit applies from the next change without rigd install.",
        ),
    })
    .prefault({})
    .describe(
      "Provider settings. providers.caddy describes a Caddy Rig does not run; a written proxy section replaces it.",
    ),
  proxy: proxySettingsSchema.optional(),
  daemon: z
    .strictObject({
      start: z
        .enum(["login", "boot"])
        .default("login")
        .describe(
          "When rigd and Rig's Caddy start. login: as LaunchAgents while you are logged in. boot: as system jobs that run as you from boot, before anyone logs in; rigd install prints one sudo line per job, once. Ignored when RIG_ROOT is set.",
        ),
    })
    .prefault({})
    .describe("How rigd is installed on this Host."),
  diagnostics: z
    .strictObject({
      retention_days: z
        .number()
        .int()
        .min(1)
        .default(14)
        .describe("Days of Diagnostic logs to keep."),
      level: z
        .enum(["debug", "info", "warn", "error"])
        .default("info")
        .describe("Diagnostic log verbosity."),
    })
    .prefault({})
    .describe("Rig Diagnostic log policy."),
  logs: z
    .strictObject({
      max_bytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .default(64 * 1024 * 1024)
        .describe(
          "Size in bytes at which a Target log file is rotated: the full file is renamed and writing starts a new one. Default 67108864 (64 MiB); at least 1048576 (1 MiB).",
        ),
      generations: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(1)
        .describe(
          "How many rotated files are kept beside the current one, newest as .1; an older one is deleted. Default 1; 0 keeps none. A Target log uses at most about max_bytes × (generations + 1) per file.",
        ),
    })
    .prefault({})
    .describe(
      "Size limits for Target logs: each Target's target.jsonl. Every writer reads a change within a few seconds.",
    ),
  monitor: z
    .strictObject({
      detail_hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .default(24)
        .describe(
          "Hours every 1-second CPU and memory sample is kept, for the charts of the last hour. Older samples survive only in the per-minute history. Default 24; 1 to 168. A change applies at rigd's next hourly prune.",
        ),
      retention_days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .default(7)
        .describe(
          "Days the per-minute CPU and memory history is kept, each minute as a distribution, so a chart of any span estimates its median and p95 from every sample in it and keeps its exact peak. Default 7; 1 to 90. About 1 MB per Component per week. A change applies at rigd's next hourly prune.",
        ),
    })
    .prefault({})
    .describe(
      "How long rigd keeps the CPU and memory it samples from every running Service and Job.",
    ),
  dashboard: z
    .union([
      z.literal(false).describe("No dashboard: rigd does not start it."),
      z.strictObject({
        port: z
          .number()
          .int()
          .min(1024)
          .max(65535)
          .default(DEFAULT_DASHBOARD_PORT)
          .describe(
            `The port on 127.0.0.1 rigd serves the dashboard on. Default ${DEFAULT_DASHBOARD_PORT}. A change applies when rigd next starts (rigd install).`,
          ),
        domain: z
          .string()
          .refine(
            (hostname) =>
              validHostname(hostname) && hostname === hostname.toLowerCase(),
            "must be a lowercase hostname such as rig.example.com; schemes, ports, paths and wildcards are not allowed",
          )
          .optional()
          .describe(
            "A hostname Rig's Caddy publishes the dashboard at, such as rig.example.com, with a certificate like a Target's. Needs a proxy section (Rig's own Caddy), and is served like a proxy.routes entry, reaching the dashboard's port only while rigd has found its own running dashboard listening there (otherwise Rig's not-running reply), so a Target or proxy.routes naming it is refused (rigd install refuses one a Target serves before restarting anything). Absent, the dashboard is reached on this Mac only. Either way every browser, this Mac's included, signs in with the access key in auth/dashboard.key under the Rig root, which the dashboard creates on first start. A change applies when rigd next starts (rigd install).",
          ),
        trusted_clients: z
          .array(
            z.string().refine((entry) => {
              try {
                parseTrustedClient(entry);
                return true;
              } catch {
                return false;
              }
            }, "must be an IP address or an IPv4 block such as 100.64.0.0/10"),
          )
          .default([])
          .describe(
            "Which addresses may reach the published dashboard and sign in with its access key. Empty (the default): any address may. Listed (IP addresses, or IPv4 blocks such as 100.64.0.0/10 for a tailnet): only this Mac and those addresses; every other address is refused outright. Either way every browser signs in with the key; a listed address never skips it. A change applies when rigd next starts (rigd install).",
          ),
      }),
    ])
    .prefault({})
    .describe(
      "The dashboard that comes with Rig: rigd starts it and keeps it running at http://127.0.0.1:<port>, and with domain Rig's Caddy publishes it. Every browser signs in with the access key in auth/dashboard.key under the Rig root. false turns it off.",
    ),
  // Retired, not refused: rigd reads this file as it starts, so a refusal would keep it from starting at all.
  alerts: z.unknown().optional().meta({
    deprecated: true,
    description:
      "No longer used: Rig sends no alerts. The section is ignored, and rig doctor asks you to delete it.",
  }),
});
/** Host config with the rules that span sections: the dashboard's domain is published by Rig's own Caddy, beside the
 * owner's proxy.routes, so it needs a proxy section and a hostname no proxy.routes entry has. */
export const checkedHostConfigSchema = hostConfigSchema.superRefine(
  (host, context) => {
    if (host.dashboard === false || host.dashboard.domain === undefined) return;
    if (!host.proxy)
      context.addIssue({
        code: "custom",
        path: ["dashboard", "domain"],
        message:
          "needs a proxy section: Rig's own Caddy publishes the dashboard (see proxy in the guide's Setup)",
      });
    else if (Object.hasOwn(host.proxy.routes, host.dashboard.domain))
      context.addIssue({
        code: "custom",
        path: ["dashboard", "domain"],
        message:
          "is also in proxy.routes; one hostname has one upstream, so remove it from one of them",
      });
  },
);
