import { z } from "zod";

const text = z.string().min(1);
const hooks = z.strictObject({
  preStart: text.optional(),
  postStart: text.optional(),
  preStop: text.optional(),
  postStop: text.optional(),
});
/** A saved Component as the retired runtime wrote it. Loose on purpose: a key this reader does not name is reported as an
 * unsupported mapping by the conversion instead of being dropped here. */
const component = z.looseObject({
  name: text,
  kind: z.enum(["managed", "installed", "persistent"]),
  env: z.record(z.string(), z.string()),
  dependsOn: z.array(text),
  envFile: text.optional(),
  hooks: hooks.optional(),
  hookTimeout: z.number().positive().optional(),
  command: text.optional(),
  entrypoint: text.optional(),
  build: z.string().optional(),
  buildTimeout: z.number().positive().optional(),
});
const plan = z.looseObject({
  project: text,
  target: z.enum(["local", "live", "preview"]),
  workspacePath: text,
  dataRoot: text,
  env: z.record(z.string(), z.string()).optional(),
  envFile: text.optional(),
  daemon: z.looseObject({ keepAlive: z.boolean().optional() }).optional(),
  components: z.array(component),
  hooks: hooks.optional(),
  hookTimeout: z.number().positive().optional(),
});
const target = z.looseObject({
  id: text,
  projectId: text,
  name: text,
  kind: z.enum(["local", "live", "preview"]),
  branch: text.optional(),
  commit: text.optional(),
  plan,
  desired: z.enum(["running", "stopped"]),
  logRoot: text,
  sourceRoot: text.optional(),
  destructionPending: z.literal(true).optional(),
  deploymentIncomplete: z.literal(true).optional(),
  recovery: z.unknown().optional(),
});
const project = z.looseObject({
  id: text,
  name: text,
  repoPath: text,
  configPath: text,
});
/** Runtime state versions 2 and 3: what the last runtime before the configuration cutover wrote. */
export const legacyStateSchema = z.looseObject({
  version: z.union([z.literal(2), z.literal(3)]),
  projects: z.array(project),
  targets: z.array(target),
  activity: z.array(z.unknown()),
});
export type LegacyState = z.infer<typeof legacyStateSchema>;
export type LegacyTarget = z.infer<typeof target>;
export type LegacyPlan = z.infer<typeof plan>;
export type LegacyComponent = z.infer<typeof component>;
export type LegacyProject = z.infer<typeof project>;
