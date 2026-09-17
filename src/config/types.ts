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
  /** The first declared port, the one status reports; absent when the Service declares none. */
  port?: number;
  /** Every declared port by name. A plan recorded before named ports carries only `port`. */
  ports?: Record<string, number>;
  sitePort?: number;
  health?: string;
  readyTimeout: number;
  /** When Rig starts the Service again after a known exit; a plan recorded without it means always. */
  restart?: RestartPolicy;
}
/** One path prefix of a Target's hostname and the declared port behind it. A prefix matches at a slash boundary and the upstream sees the path unchanged. */
export interface PlanRoute {
  prefix: string;
  service: string;
  port: number;
}
export type RestartPolicy = "always" | "on-failure" | "no";
export interface InstalledComponent extends ComponentContext {
  kind: "installed";
  entrypoint: string;
  installName?: string;
}
export interface PersistentComponent extends ComponentContext {
  kind: "persistent";
  uses: "sqlite";
  path: string;
}
/** One build command of a Target plan. Units never merge, even when two declare the same shell text. */
export interface BuildUnit {
  /** `shared`, `service:<name>` or `tool:<name>`: the identity the unit's outcome is recorded under. */
  id: string;
  /** The Service or Tool whose environment scope the command runs in; absent for the shared Project build. */
  component?: string;
  command: string;
  /** Seconds before the build is killed and recorded as failed. */
  timeout: number;
  /** Public env leaves the shared command was built from; a Component's unit is guarded by its Component's commandInputs. */
  commandInputs?: PublicInput[];
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
  /** Build units in run order: shared, Services in dependency order, then Tools by name. Absent on plans recorded before builds were units. */
  builds?: BuildUnit[];
  preparedComponents: PreparedComponent[];
  domain?: string;
  /** `upstream` is the Service behind '/'. `routes` is the whole map, longest prefix first; a plan recorded before route maps has only `upstream`. */
  proxy?: { upstream: string; routes?: PlanRoute[] };
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
