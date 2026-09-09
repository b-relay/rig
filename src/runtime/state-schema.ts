import { z } from "zod";
const text = z.string().min(1);
const hooks = z.object({
  preStart: z.string().optional(),
  postStart: z.string().optional(),
  preStop: z.string().optional(),
  postStop: z.string().optional(),
});
const common = {
  name: text,
  env: z.record(z.string(), z.string()),
  envFile: text.optional(),
  hooks: hooks.optional(),
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
    build: z.string().optional(),
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
  envFile: text.optional(),
});
const project = z.object({
  id: text,
  name: text,
  repoPath: text,
  configPath: text,
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
  recovery: z
    .object({
      plan: targetPlanSchema,
      branch: text.optional(),
      commit: text.optional(),
      desired: z.enum(["running", "stopped"]),
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
export const runtimeStateSchema = z
  .object({
    version: z.literal(2),
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
