import { isAbsolute } from "node:path";
import { z } from "zod";
const text = z.string().min(1);
/** Registered paths are stored absolute, so comparing two of them never depends on rigd's working directory. */
const absolutePath = text.refine(isAbsolute, {
  message: "must be an absolute path",
});
const hooks = z.object({
  preStart: z.string().optional(),
  postStart: z.string().optional(),
  preStop: z.string().optional(),
  postStop: z.string().optional(),
});
const envFiles = z
  .array(z.object({ path: absolutePath, required: z.boolean() }))
  .optional();
const commandInputs = z
  .array(z.object({ name: text, source: text, value: z.string() }))
  .optional();
const common = {
  name: text,
  env: z.record(z.string(), z.string()),
  envFiles,
  commandInputs,
  hooks: hooks.optional(),
  hookTimeout: z.number().positive().optional(),
  dependsOn: z.array(text),
};
const component = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("managed"),
    command: text,
    port: z.number().int().min(1).max(65535),
    sitePort: z.number().int().min(1).max(65535).optional(),
    health: text.optional(),
    readyTimeout: z.number().positive(),
  }),
  z.object({
    ...common,
    kind: z.literal("installed"),
    entrypoint: text,
    installName: text.optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("persistent"),
    uses: z.literal("sqlite"),
    path: text,
  }),
]);
export const targetPlanSchema = z.object({
  project: text,
  target: z.enum(["local", "live", "preview"]),
  workspacePath: text,
  dataRoot: text,
  deploymentName: text,
  branchSlug: text,
  subdomain: z.string(),
  branch: text.optional(),
  commit: text.optional(),
  providers: z.object({ processSupervisor: text }),
  providerProfile: text,
  env: z.record(z.string(), z.string()).optional(),
  daemon: z
    .object({
      enabled: z.boolean().optional(),
      keepAlive: z.boolean().optional(),
    })
    .optional(),
  components: z.array(component),
  builds: z
    .array(
      z.object({
        id: text,
        component: text.optional(),
        command: text,
        timeout: z.number().positive(),
        commandInputs,
      }),
    )
    .optional(),
  preparedComponents: z.array(
    z.discriminatedUnion("uses", [
      z.object({ name: text, uses: z.literal("sqlite"), path: text }),
      z.object({ name: text, uses: z.literal("convex"), stateDir: text }),
      z.object({ name: text, uses: z.literal("postgres"), dataDir: text }),
    ]),
  ),
  domain: text.optional(),
  proxy: z.object({ upstream: text }).optional(),
  hooks: hooks.optional(),
  hookTimeout: z.number().positive().optional(),
  installTimeout: z.number().positive().optional(),
  envFiles,
});
const preparation = z
  .object({
    deployment: text.describe(
      "The workspace the outcomes belong to; outcomes never carry over to another workspace.",
    ),
    units: z.record(
      text,
      z.object({
        state: z
          .enum(["started", "succeeded", "failed"])
          .describe(
            "started outside a running operation means the outcome is unknown.",
          ),
        policy: text.describe(
          "Digest of the unit's public policy; never env-file values.",
        ),
        commit: text.optional(),
        startedAt: text,
        finishedAt: text.optional(),
      }),
    ),
  })
  .optional();
const project = z.object({
  id: text,
  name: text,
  repoPath: absolutePath,
  configPath: absolutePath,
  createdAt: text,
});
const target = z.object({
  id: text,
  projectId: text,
  name: text,
  kind: z.enum(["local", "live", "preview"]),
  branch: text.optional(),
  commit: text.optional(),
  plan: targetPlanSchema,
  desired: z.enum(["running", "stopped"]),
  createdAt: text,
  updatedAt: text,
  logRoot: text,
  sourceRoot: text.optional(),
  destructionPending: z
    .literal(true)
    .optional()
    .describe(
      "Preview deletion is pending; retain inventory and retry explicit destroy without restarting.",
    ),
  deploymentIncomplete: z
    .literal(true)
    .optional()
    .describe("Deployment has not committed; matching source must be retried."),
  preparation,
  configRevision: text
    .optional()
    .describe(
      "Revision of the rig.yaml a Working copy plan was made from, for reporting drift.",
    ),
  recovery: z
    .object({
      plan: targetPlanSchema,
      preparation,
      branch: text.optional(),
      commit: text.optional(),
      desired: z.enum(["running", "stopped"]),
      deploymentIncomplete: z
        .literal(true)
        .optional()
        .describe("The rollback plan has not completed a deployment."),
      stage: z.enum(["pending", "blocked", "committing"]),
    })
    .optional(),
});
const operation = z.object({
  id: text,
  projectId: text.optional(),
  project: text.optional(),
  target: text.optional(),
  action: text,
  outcome: z.enum([
    "started",
    "stopped",
    "deployed",
    "failed",
    "unchanged",
    "registered",
    "renamed",
    "repointed",
    "installed",
    "uninstalled",
  ]),
  occurredAt: text,
  message: z.string().optional(),
});
/** The state file format this rigd writes. Bump it whenever a record gains or changes a field so that an
 * older rigd refuses the file instead of silently dropping what it does not know. Version 2 files differ
 * only by the fields added since, all optional, so they are read as-is and rewritten as version 3. */
export const STATE_VERSION = 3;
export const runtimeStateSchema = z
  .object({
    version: z.union([z.literal(2), z.literal(STATE_VERSION)]),
    projects: z.array(project),
    targets: z.array(target),
    activity: z.array(operation),
  })
  .superRefine((state, ctx) => {
    const ids = new Set<string>(),
      names = new Set<string>(),
      targetIds = new Set<string>(),
      targetNames = new Set<string>();
    for (const project of state.projects) {
      if (ids.has(project.id) || names.has(project.name))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate Project identity.",
        });
      ids.add(project.id);
      names.add(project.name);
    }
    for (const target of state.targets) {
      if (
        !ids.has(target.projectId) ||
        targetIds.has(target.id) ||
        targetNames.has(`${target.projectId}:${target.name}`)
      )
        ctx.addIssue({ code: "custom", message: "Invalid Target identity." });
      targetIds.add(target.id);
      targetNames.add(`${target.projectId}:${target.name}`);
      const owner = state.projects.find((p) => p.id === target.projectId);
      if (
        target.kind !== target.plan.target ||
        target.name !== target.plan.deploymentName ||
        target.plan.project !== owner?.name
      )
        ctx.addIssue({
          code: "custom",
          message: "Target plan identity differs from its record.",
        });
      const components = new Set<string>();
      for (const component of target.plan.components) {
        if (
          components.has(component.name) ||
          component.dependsOn.some((d) => !components.has(d))
        )
          ctx.addIssue({
            code: "custom",
            message: "Component identities or dependency order are invalid.",
          });
        components.add(component.name);
      }
    }
  });
