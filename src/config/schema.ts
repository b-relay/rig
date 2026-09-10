import { z } from "zod";
import { ConfigError } from "./errors.js";
const text = z.string().min(1);
const name = text
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .describe("Stable registered Project name.");
const componentName = text
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .describe("Component name used in dependencies and output.");
const port = z
  .number()
  .int()
  .min(1)
  .max(65535)
  .describe("Local TCP port from 1 to 65535.");
/** Validates explicit bind flags; ordinary command URL arguments may reference remote services. */
export function localhostCommand(value: string): boolean {
  const tokens = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.replace(/^['"]|['"]$/g, "");
    const match =
      /^--(?:host|hostname|bind|bind-host|listen|listen-host|addr|address)(?:=(.+))?$/.exec(
        token,
      );
    if (match) {
      const host = (match[1] ?? tokens[++i] ?? "")
        .replace(/^['"]|['"]$/g, "")
        .replace(/:\d+$/, "");
      if (!["localhost", "127.0.0.1"].includes(host)) return false;
    }
  }
  return !/(?:^|[\s=])(?:0\.0\.0\.0|\[?::\]?)(?=[:\s]|$)/.test(value);
}
const command = text
  .refine(
    (value) => localhostCommand(value.replace(/\$\{[^}]+\}/g, "1234")),
    "Explicit network bindings must use 127.0.0.1 or localhost.",
  )
  .describe("Shell command; explicit bindings must be localhost only.");
const health = text
  .refine((value) => {
    if (!localhostCommand(value)) return false;
    for (const match of value.matchAll(/https?:\/\/[^\s'"/]+/g)) {
      try {
        const hostname = new URL(match[0].replace(/\$\{[^}]+\}/g, "1234"))
          .hostname;
        if (!["127.0.0.1", "localhost"].includes(hostname)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }, "Health checks must address 127.0.0.1 or localhost.")
  .describe("Local HTTP URL or shell command used to check readiness.");
const route = text
  .regex(/^[^\s;"`{}]+$/)
  .or(text.regex(/^\$\{[^}]+\}[^\s;"`]*$/))
  .describe("Single domain token; interpolation is supported.");
const hooks = z.strictObject({
  preStart: z.string().optional().describe("Run before starting."),
  postStart: z.string().optional().describe("Run after readiness."),
  preStop: z
    .string()
    .optional()
    .describe("Run before stopping active managed processes; skipped when already stopped."),
  postStop: z.string().optional().describe("Run after stopping."),
});
const common = {
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Inline process environment."),
  envFile: text
    .optional()
    .describe("Environment file relative to the workspace."),
  hooks: hooks.optional().describe("Component lifecycle hooks."),
};
const runtime = {
  command: command.optional(),
  port: port.optional(),
  health: health.optional(),
  readyTimeout: z
    .number()
    .min(1)
    .optional()
    .describe("Startup readiness timeout in seconds."),
  dependsOn: z
    .array(componentName)
    .optional()
    .describe("Components that must become ready first."),
};
const component = z.union([
  z.strictObject({
    mode: z.literal("managed").describe("Supervised long-running process."),
    ...runtime,
    command,
    ...common,
  }),
  z.strictObject({
    mode: z.literal("installed").describe("Installed executable."),
    entrypoint: text.describe("Executable path relative to the workspace."),
    build: z.string().optional().describe("Build command before installation."),
    installName: componentName
      .optional()
      .describe("Installed executable name."),
    ...common,
  }),
  z.strictObject({
    uses: z.literal("sqlite").describe("Persistent SQLite dependency."),
    path: text
      .optional()
      .describe("Database path; defaults to Target persistent storage."),
  }),
  z.strictObject({
    uses: z.literal("convex").describe("Convex Local dependency."),
    ...runtime,
    sitePort: port.optional().describe("Convex site-proxy port."),
    ...common,
  }),
  z.strictObject({
    uses: z.literal("postgres").describe("Postgres dependency."),
    ...runtime,
    ...common,
  }),
]);
const override = z.strictObject({
  ...runtime,
  sitePort: port.optional().describe("Convex site-proxy port."),
  entrypoint: text.optional().describe("Installed executable path override."),
  build: z.string().optional().describe("Build command override."),
  installName: componentName
    .optional()
    .describe("Installed executable name override."),
  path: text.optional().describe("SQLite path override."),
  ...common,
});
const lane = z.strictObject({
  components: z
    .record(componentName, override)
    .optional()
    .describe("Overrides keyed by shared Component name."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Environment inherited by every Component."),
  envFile: text.optional().describe("Default environment file."),
  proxy: z
    .strictObject({
      upstream: componentName.describe(
        "Managed Component receiving route traffic.",
      ),
    })
    .optional()
    .describe("Reverse proxy policy."),
  daemon: z
    .strictObject({
      enabled: z
        .boolean()
        .optional()
        .describe("Install persistent supervision."),
      keepAlive: z.boolean().optional().describe("Restart exited processes."),
    })
    .optional()
    .describe("Legacy supervision policy."),
  providers: z
    .strictObject({
      processSupervisor: text
        .optional()
        .describe("Selected process-supervisor provider identifier."),
    })
    .optional()
    .describe("Provider selections."),
  domain: route.optional().describe("Target domain override."),
  subdomain: route.optional().describe("Preview subdomain template."),
  deployBranch: text
    .optional()
    .describe("Production branch for the Stable Target."),
  providerProfile: z
    .literal("default")
    .optional()
    .describe(
      "Provider profile. Only default is supported; test isolation uses explicit provider interfaces and RIG_ROOT.",
    ),
});
export const projectConfigSchema = z
  .strictObject({
    name,
    description: z.string().optional().describe("Project description."),
    domain: route.optional().describe("Base domain template."),
    hooks: hooks.optional().describe("Project lifecycle hooks."),
    components: z
      .record(componentName, component)
      .describe("Shared Component definitions."),
    local: lane.optional().describe("Working copy Target overrides."),
    live: lane.optional().describe("Stable Target overrides."),
    deployments: lane.optional().describe("Preview template overrides."),
  })
  .superRefine((config, ctx) => {
    for (let [laneName, target] of Object.entries({
      base: undefined as z.infer<typeof lane> | undefined,
      local: config.local,
      live: config.live,
      deployments: config.deployments,
    })) {
      if (!target && laneName !== "base") continue;
      target ??= {};
      const definitions: Record<
        string,
        Record<string, unknown>
      > = Object.create(null);
      for (const [key, base] of Object.entries(config.components)) {
        const patch = target.components?.[key] ?? {};
        const result = component.safeParse({ ...base, ...patch });
        if (!result.success)
          ctx.addIssue({
            code: "custom",
            path: [laneName, "components", key],
            message: "Overrides must match the Component kind.",
          });
        definitions[key] = { ...base, ...patch };
      }
      for (const key of Object.keys(target.components ?? {}))
        if (!Object.hasOwn(config.components, key))
          ctx.addIssue({
            code: "custom",
            path: [laneName, "components", key],
            message: "Override references an unknown Component.",
          });
      const visiting = new Set<string>(),
        done = new Set<string>();
      const visit = (key: string): void => {
        if (visiting.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: [laneName, "components", key, "dependsOn"],
            message: "Component dependencies contain a cycle.",
          });
          return;
        }
        if (done.has(key)) return;
        visiting.add(key);
        for (const dependency of (definitions[key]?.dependsOn as
          | string[]
          | undefined) ?? []) {
          if (
            !definitions[dependency] ||
            definitions[dependency]?.mode === "installed"
          )
            ctx.addIssue({
              code: "custom",
              path: [laneName, "components", key, "dependsOn"],
              message: `Dependency '${dependency}' must reference a managed or persistent Component.`,
            });
          else visit(dependency);
        }
        visiting.delete(key);
        done.add(key);
      };
      for (const key of Object.keys(definitions)) visit(key);
      if (
        "proxy" in target &&
        target.proxy &&
        !(
          definitions[target.proxy.upstream]?.mode === "managed" ||
          ["convex", "postgres"].includes(
            String(definitions[target.proxy.upstream]?.uses),
          )
        )
      )
        ctx.addIssue({
          code: "custom",
          path: [laneName, "proxy"],
          message: "Proxy upstream must reference a managed Component.",
        });
    }
  });
export function parseProjectConfig(value: unknown) {
  const result = projectConfigSchema.safeParse(value);
  if (!result.success) throw validationError("Project", result.error.issues);
  return result.data;
}
export const hostConfigSchema = z.strictObject({
  deploy: z
    .strictObject({
      productionBranch: text
        .default("main")
        .describe("Default Production branch."),
      generated: z
        .strictObject({
          maxActive: z
            .number()
            .int()
            .min(1)
            .default(5)
            .describe("Maximum active Previews per Project."),
          replacePolicy: z
            .enum(["oldest", "reject"])
            .default("oldest")
            .describe("Policy at the Preview limit."),
        })
        .prefault({})
        .describe("Preview inventory limits."),
    })
    .prefault({})
    .describe("Host deployment defaults."),
  providers: z
    .strictObject({
      defaultProfile: z
        .literal("default")
        .default("default")
        .describe(
          "Host provider profile. Only default is supported; unsupported profiles fail before runtime effects.",
        ),
      caddy: z
        .strictObject({
          caddyfile: text.optional().describe("Host Caddyfile path."),
          extraConfig: z
            .array(text)
            .default([])
            .describe("Extra trusted Caddy site directives."),
          reload: z
            .strictObject({
              mode: z
                .enum(["manual", "command", "disabled"])
                .default("manual")
                .describe("Caddy reload policy."),
              command: text
                .optional()
                .describe(
                  "Explicit Host Caddy reload command; required when mode is command.",
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
        .describe("Caddy provider capability."),
    })
    .prefault({})
    .describe("Provider defaults."),
  web: z
    .strictObject({
      controlPlane: z
        .enum(["localhost", "tailscale", "cloudflare", "disabled"])
        .default("localhost")
        .describe("Control-plane exposure preference."),
      hosted: z
        .strictObject({
          enabled: z
            .boolean()
            .default(false)
            .describe("Enable outbound hosted connection."),
          endpoint: text.optional().describe("Hosted control-plane endpoint."),
          machineId: text.optional().describe("Hosted machine identity."),
          pairingToken: text
            .optional()
            .describe("Secret hosted pairing token."),
        })
        .prefault({})
        .describe("Hosted connection settings."),
    })
    .prefault({})
    .describe("Web control defaults."),
  diagnostics: z
    .strictObject({
      retentionDays: z
        .number()
        .int()
        .min(1)
        .default(14)
        .describe("Diagnostic log retention in days."),
      level: z
        .enum(["debug", "info", "warn", "error"])
        .default("info")
        .describe("Diagnostic verbosity."),
    })
    .prefault({})
    .describe("Rig diagnostic policy."),
});
export function parseHostConfig(value: unknown) {
  const result = hostConfigSchema.safeParse(value);
  if (!result.success) throw validationError("Host", result.error.issues);
  return result.data;
}

/** Human guidance contains field paths and schema messages, never input values. */
function validationError(
  scope: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): ConfigError {
  const safe = (value: string) =>
    value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);
  const details = issues.map((issue) => ({
    path: issue.path.map((part) => safe(String(part))),
    message: safe(issue.message),
  }));
  const hint =
    "Fix " +
    details
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ") +
    ".";
  return new ConfigError(
    `Invalid ${scope} configuration.`,
    "invalid_config",
    { issues: details },
    hint.slice(0, 900),
  );
}
