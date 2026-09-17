import type { z } from "zod";
import type { projectConfigSchema, hostConfigSchema } from "./schema.js";
import type { PublicInput } from "./references.js";

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type HostConfig = z.infer<typeof hostConfigSchema>;
export interface ConfigDocument<T> {
  path: string;
  revision: string;
  config: T;
}
export interface Hooks {
  preStart?: string;
  postStart?: string;
  preStop?: string;
  postStop?: string;
}
/** One env file an invocation loads; only the reference is recorded, never the contents. */
export interface EnvFileRef {
  /** Absolute path. */
  path: string;
  /** A listed file must exist; an operator convention file is read when present. */
  required: boolean;
}
interface ComponentContext {
  name: string;
  /** Public values only: Project env, then this Service's env. */
  env: Record<string, string>;
  /** Lowest to highest precedence; every file beats `env`. */
  envFiles?: EnvFileRef[];
  /** Public env leaves the run, build and shell readiness commands were built from; a file may not change them. */
  commandInputs?: PublicInput[];
  hooks?: Hooks;
  /** Seconds; absent means the Project hookTimeout, then 120. */
  hookTimeout?: number;
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
  /** Seconds; absent means 600. */
  buildTimeout?: number;
  installName?: string;
}
export interface PersistentComponent extends ComponentContext {
  kind: "persistent";
  uses: "sqlite";
  path: string;
}
export type PlanComponent =
  ManagedComponent | InstalledComponent | PersistentComponent;
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
  /** Seconds for Project hooks and the Component default; absent means 120. */
  hookTimeout?: number;
  /** Seconds for dependency installation; absent means 600. */
  installTimeout?: number;
  /** The Project-scope files a Project or Tool invocation loads, lowest to highest precedence. */
  envFiles?: EnvFileRef[];
}
/** Host facts the pure resolver needs for env-file references; the composition root acquires them. */
export interface ResolveHost {
  /** Absolute operator home that `~` in env_file means. */
  operatorHome: string;
  /** Absolute directory of operator convention files: <envRoot>/<project>[/<service>]/{all,<role>}.env. */
  envRoot: string;
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
