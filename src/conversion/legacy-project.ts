import { z } from "zod";

/** The retired Project configuration (`rig.json`, or a `rig.yaml` of the same shape), read only by the conversion. Strict on
 * purpose: a key this reader does not know makes the candidate impossible instead of silently incomplete. Values are not
 * re-validated; the retired runtime already accepted them. */
const text = z.string().min(1);
const env = z.record(z.string(), z.string());
const hooks = z.strictObject({
  preStart: text.optional(),
  postStart: text.optional(),
  preStop: text.optional(),
  postStop: text.optional(),
});
const common = {
  env: env.optional(),
  envFile: text.optional(),
  hooks: hooks.optional(),
  hookTimeout: z.number().optional(),
};
const runtime = {
  command: text.optional(),
  port: z.number().int().optional(),
  health: text.optional(),
  readyTimeout: z.number().optional(),
  dependsOn: z.array(text).optional(),
};
const installed = {
  entrypoint: text,
  build: z.string().optional(),
  installName: text.optional(),
  buildTimeout: z.number().optional(),
};
const component = z.union([
  z.strictObject({
    mode: z.literal("managed"),
    ...runtime,
    command: text,
    ...common,
  }),
  z.strictObject({ mode: z.literal("installed"), ...installed, ...common }),
  z.strictObject({ uses: z.literal("sqlite"), path: text.optional() }),
  z.strictObject({
    uses: z.literal("convex"),
    ...runtime,
    sitePort: z.number().int().optional(),
    ...common,
  }),
  z.strictObject({ uses: z.literal("postgres"), ...runtime, ...common }),
]);
const override = z.strictObject({
  ...runtime,
  sitePort: z.number().int().optional(),
  ...installed,
  entrypoint: text.optional(),
  path: text.optional(),
  ...common,
});
const lane = z.strictObject({
  components: z.record(text, override).optional(),
  env: env.optional(),
  envFile: text.optional(),
  proxy: z.strictObject({ upstream: text }).optional(),
  daemon: z
    .strictObject({
      enabled: z.boolean().optional(),
      keepAlive: z.boolean().optional(),
    })
    .optional(),
  providers: z
    .strictObject({
      processSupervisor: z.enum(["rigd", "child", "launchd"]).optional(),
    })
    .optional(),
  domain: text.optional(),
  subdomain: text.optional(),
  deployBranch: text.optional(),
  providerProfile: z.literal("default").optional(),
});
export const legacyProjectSchema = z.strictObject({
  name: text,
  description: z.string().optional(),
  domain: text.optional(),
  hooks: hooks.optional(),
  hookTimeout: z.number().optional(),
  installTimeout: z.number().optional(),
  components: z.record(text, component),
  local: lane.optional(),
  live: lane.optional(),
  deployments: lane.optional(),
});
export type LegacyProjectConfig = z.infer<typeof legacyProjectSchema>;
export type LegacyLane = z.infer<typeof lane>;
export type LegacyComponentConfig = z.infer<typeof component>;
