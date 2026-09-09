import type { z } from "zod";
import type { projectConfigSchema, hostConfigSchema } from "./schema.js";

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type HostConfig = z.infer<typeof hostConfigSchema>;
export interface ConfigDocument<T> {
  path: string;
  format: "yaml" | "json";
  revision: string;
  config: T;
}
export interface Hooks {
  preStart?: string;
  postStart?: string;
  preStop?: string;
  postStop?: string;
}
interface ComponentContext {
  name: string;
  env: Record<string, string>;
  envFile?: string;
  hooks?: Hooks;
  dependsOn: string[];
}
export interface ManagedComponent extends ComponentContext {
  kind: "managed";
  command: string;
  port: number;
  sitePort?: number;
  health?: string;
  readyTimeout: number;
}
export interface InstalledComponent extends ComponentContext {
  kind: "installed";
  entrypoint: string;
  build?: string;
  installName?: string;
}
export interface PersistentComponent extends ComponentContext {
  kind: "persistent";
  uses: "sqlite";
  path: string;
}
export type PlanComponent =
  | ManagedComponent
  | InstalledComponent
  | PersistentComponent;
export type PreparedComponent =
  | { name: string; uses: "sqlite"; path: string }
  | { name: string; uses: "convex"; stateDir: string }
  | { name: string; uses: "postgres"; dataDir: string };
export interface TargetPlan {
  project: string;
  target: "local" | "live" | "preview";
  workspacePath: string;
  dataRoot: string;
  deploymentName: string;
  branchSlug: string;
  subdomain: string;
  branch?: string;
  commit?: string;
  providers: { processSupervisor: string };
  daemon?: { enabled?: boolean; keepAlive?: boolean };
  providerProfile: string;
  env?: Record<string, string>;
  components: PlanComponent[];
  preparedComponents: PreparedComponent[];
  domain?: string;
  proxy?: { upstream: string };
  hooks?: Hooks;
  envFile?: string;
}
/** Roots are caller-acquired strings; resolveTargetPlan validates absolute identity before calculation. */
export interface ResolveTargetPlanInput {
  config: ProjectConfig;
  target: "local" | "live" | "preview";
  workspacePath: string;
  dataRoot: string;
  branch?: string;
  commit?: string;
  deploymentName?: string;
  branchSlug?: string;
  subdomain?: string;
  assignedPorts?: Readonly<Record<string, number>>;
}
