import type { z } from "zod";
import type { hostConfigSchema, ProjectConfig } from "./schema";
import type { ConfigFormat } from "./formats";
import type { PublicInput } from "./references";

export type { ProjectConfig } from "./schema";
export type { ConfigFormat } from "./formats";
export type HostConfig = z.infer<typeof hostConfigSchema>;
export interface ConfigDocument<T> {
  path: string;
  revision: string;
  config: T;
  /** The format a Project document is written in; `config` always has the latest format's shape. Absent for Host config. */
  format?: ConfigFormat;
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
  /** Seconds the Service may take to exit after SIGTERM before SIGKILL; a plan recorded before stop_timeout existed has
   * none and gets the 10 s default. */
  stopTimeout?: number;
  /** When Rig starts the Service again after a known exit; a plan recorded without it means always. */
  restart?: RestartPolicy;
  /** Ongoing checks of `health` while the Service runs, from health.interval and its companions (seconds); absent when
   * the check runs only at start. */
  healthMonitor?: HealthMonitorPlan;
}
/** How rigd keeps checking a running Service (#282). */
export interface HealthMonitorPlan {
  /** Seconds between checks. */
  interval: number;
  /** Seconds one check may take before it counts as failed. */
  timeout: number;
  /** Failed checks in a row before Rig acts. */
  failures: number;
  onFailure: "report" | "restart";
  /** Seconds Rig keeps restarting a Service that stays unhealthy; forever when absent. */
  retryFor?: number;
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
  env?: Record<string, string>;
  components: PlanComponent[];
  /** Build units in run order: shared, Services in dependency order, then Tools by name. Absent on plans recorded before builds were units. */
  builds?: BuildUnit[];
  preparedComponents: PreparedComponent[];
  domain?: string;
  /** `upstream` is the Service behind '/'. `routes` is the whole map, longest prefix first; a plan recorded before route maps has only `upstream`. */
  proxy?: { upstream: string; routes?: PlanRoute[] };
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
