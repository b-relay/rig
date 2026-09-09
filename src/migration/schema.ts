import { z } from "zod";
import { isAbsolute } from "node:path";
const text = z.string().min(1);
const name = text.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const path = text.refine(isAbsolute, "Recorded paths must be absolute.");
const timestamp = z.string().datetime({ offset: true });
const hooks = z.object({
  preStart: z.string().optional(),
  postStart: z.string().optional(),
  preStop: z.string().optional(),
  postStop: z.string().optional(),
});
const component = z.discriminatedUnion("kind", [
  z.object({
    name,
    kind: z.literal("managed"),
    command: text,
    port: z.number().int().min(1).max(65535),
    health: text.optional(),
    readyTimeout: z.number().positive(),
    dependsOn: z.array(name).optional(),
    env: z.record(z.string(), z.string()).optional(),
    envFile: text.optional(),
    hooks: hooks.optional(),
  }),
  z.object({
    name,
    kind: z.literal("installed"),
    entrypoint: text,
    build: z.string().optional(),
    installName: name.optional(),
    env: z.record(z.string(), z.string()).optional(),
    envFile: text.optional(),
    hooks: hooks.optional(),
  }),
]);
const prepared = z.discriminatedUnion("uses", [
  z.object({ name, uses: z.literal("sqlite"), path }),
  z.object({ name, uses: z.literal("postgres"), dataDir: path }),
  z.object({ name, uses: z.literal("convex"), stateDir: path }),
]);
const plan = z.object({
  project: name,
  lane: z.enum(["local", "live", "deployment"]),
  deploymentName: name,
  branchSlug: text,
  subdomain: z.string(),
  workspacePath: path,
  dataRoot: path,
  providerProfile: text,
  providers: z.object({ processSupervisor: text }),
  components: z.array(component),
  preparedComponents: z.array(prepared),
  proxy: z.object({ upstream: name }).optional(),
  hooks: hooks.optional(),
  deployBranch: text.optional(),
  envFile: text.optional(),
  domain: text.optional(),
});
export const legacyRecordSchema = z.object({
  project: name,
  kind: z.enum(["local", "live", "generated"]),
  name,
  sourceRef: text.optional(),
  sourceCommit: z
    .string()
    .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
    .optional(),
  branchSlug: text,
  subdomain: z.string(),
  workspacePath: path,
  dataRoot: path,
  logRoot: path,
  runtimeRoot: path,
  runtimeStatePath: path,
  assignedPorts: z.record(z.string(), z.number().int().min(1).max(65535)),
  providerProfile: text,
  resolved: z.object({
    project: name,
    lane: z.enum(["local", "live", "deployment"]),
    deploymentName: name,
    branchSlug: text,
    subdomain: z.string(),
    workspacePath: path,
    dataRoot: path,
    sourceRepoPath: path.optional(),
    providerProfile: text,
    providers: z.object({ processSupervisor: text }),
    preparedComponents: z.array(prepared),
    runtimePlan: plan,
    environment: z.object({ services: z.array(z.unknown()) }).passthrough(),
    v1Config: z
      .object({
        daemon: z
          .object({
            enabled: z.boolean().optional(),
            keepAlive: z.boolean().optional(),
          })
          .optional(),
      })
      .passthrough(),
  }),
});
export const legacyStateSchema = z.object({
  version: z.literal(1),
  events: z.array(
    z.object({
      timestamp,
      event: text,
      project: name.optional(),
      lane: z.string().optional(),
      deployment: z.string().optional(),
      component: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  receipts: z.array(
    z.object({
      id: text,
      kind: z.enum(["lifecycle", "deploy", "destroy"]),
      accepted: z.literal(true),
      project: name,
      stateRoot: path,
      target: text,
      receivedAt: timestamp,
    }),
  ),
  healthSummaries: z.array(
    z.object({
      service: z.literal("rigd"),
      status: z.literal("running"),
      checkedAt: timestamp,
      providerProfile: text,
    }),
  ),
  providerObservations: z.array(
    z.object({
      id: text,
      family: text,
      status: z.enum(["confirmed", "stale", "missing"]),
      observedAt: timestamp,
      capabilities: z.array(text),
    }),
  ),
  portReservations: z.array(
    z.object({
      project: name,
      deployment: name,
      component: text,
      port: z.number().int().min(1).max(65535),
      owner: z.literal("rigd"),
      status: z.enum(["reserved", "stale"]),
      observedAt: timestamp,
    }),
  ),
  deploymentSnapshots: z.array(
    z.object({
      project: name,
      deployment: name,
      kind: z.enum(["local", "live", "generated"]),
      observedAt: timestamp,
      providerProfile: text,
    }),
  ),
  desiredDeployments: z.array(
    z.object({
      project: name,
      deployment: name,
      kind: z.enum(["local", "live", "generated"]),
      desiredStatus: z.enum(["running", "stopped", "failed"]),
      updatedAt: timestamp,
      providerProfile: text,
      record: legacyRecordSchema,
    }),
  ),
  managedServiceFailures: z.array(
    z.object({
      project: name,
      deployment: name,
      component: name,
      occurredAt: timestamp,
      exitCode: z.number().int().optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
    }),
  ),
});
export const legacyRegistrySchema = z.record(
  name,
  z.object({ repoPath: path, registeredAt: timestamp }),
);
export type LegacyState = z.infer<typeof legacyStateSchema>;
export type LegacyRecord = z.infer<typeof legacyRecordSchema>;
export type LegacyRegistry = z.infer<typeof legacyRegistrySchema>;
