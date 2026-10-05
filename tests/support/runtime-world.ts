import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTargetEffects,
  type TargetAdapterOptions,
} from "../../src/adapters/target-effects";
import {
  parseHostConfig,
  resolveTargetPlan,
  type ProjectConfig,
} from "../../src/config";
import { createArtifactInstaller } from "../../src/providers/artifact-installer";
import type { Router } from "../../src/providers/caddy-router";
import { runCommand } from "../../src/providers/command-runner";
import type { Supervisor } from "../../src/providers/contracts";
import { createRuntime } from "../../src/runtime/application";
import { timerObservationDeadline } from "../../src/runtime/bounded-observations";
import type { RuntimeDependencies } from "../../src/runtime/contracts";
import {
  createTargetLifecycle,
  type LifecycleObserver,
  type ReadinessTiming,
} from "../../src/runtime/lifecycle";
import { FileStateStore } from "../../src/runtime/state-store";
import { localActivation } from "./activation-doubles";
import { unreloadedCaddy } from "./router-doubles";

/** Readiness polls fire at once; a readiness deadline ends after `deadlineMs` of real time, long enough for a test to act
 * while a check is pending. A process counts as started as soon as it is spawned, until a test sets `startGraceMs`. */
export function promptReadiness(
  deadlineMs: number,
): ReadinessTiming & { startGraceMs: number } {
  return {
    schedule(delayMs, fire) {
      const timer = setTimeout(fire, delayMs < 1000 ? 0 : deadlineMs);
      return () => clearTimeout(timer);
    },
    startGraceMs: 0,
  };
}

export interface RuntimeWorldOptions {
  /** Names the temporary Rig root: `rig-<name>-`. */
  readonly name: string;
  /** The one Project's rig.yaml wherever it is read; read live, so a test may edit it in place. */
  readonly config: ProjectConfig;
  /** Owns every Service process, as the `rigd` supervisor; given the world's root. */
  readonly supervisor: (root: string) => Supervisor;
  /** Where the scripted clock starts, as an ISO timestamp. */
  readonly startsAt: string;
  /** Real milliseconds a readiness deadline lasts; see `promptReadiness`. */
  readonly readinessDeadlineMs: number;
  /** Replaces `promptReadiness`: when a start check's deadline fires, decided by the test. */
  readonly timing?: ReadinessTiming & { startGraceMs: number };
  /** Port and listener evidence; when absent every port answers and the owned process listens on nothing. */
  readonly activation?: Pick<TargetAdapterOptions, "connect" | "listeners">;
  /** Publishes routes; `unreloadedCaddy` when absent. */
  readonly router?: Router;
  /** Told about each start and stop as it begins, and each passed start check, as rigd tells its health monitor. */
  readonly lifecycleObserver?: LifecycleObserver;
  /** Rewrites the config each Target plan is resolved from. */
  readonly planConfig?: (config: ProjectConfig) => ProjectConfig;
  /** Dependencies that replace or add to the world's own, given its root and state file. */
  readonly dependencies?: (world: {
    root: string;
    store: FileStateStore;
  }) => Partial<RuntimeDependencies>;
}

/** The real runtime, lifecycle, Target effects and state file for one Project under a temporary Rig root, over a scripted
 * supervisor and clock: no launchd, no Caddy, no Service process, no Host inspection. The caller removes `root`. */
export async function runtimeWorld(options: RuntimeWorldOptions) {
  const root = await mkdtemp(join(tmpdir(), `rig-${options.name}-`));
  const repo = join(root, "repo");
  await mkdir(repo);
  const clock = { ms: Date.parse(options.startsAt) };
  const effects = createTargetEffects({
    ...(options.activation ?? localActivation()),
    recordingTime: () => new Date(clock.ms).toISOString(),
    root,
    environment: {},
    supervisors: new Map([["rigd", options.supervisor(root)]]),
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: options.router ?? unreloadedCaddy(root),
    run: runCommand,
  });
  const timing = options.timing ?? promptReadiness(options.readinessDeadlineMs);
  const store = new FileStateStore(root);
  const planConfig = options.planConfig ?? ((config) => config);
  let id = 0;
  const deps = {
    root,
    async readAdminActivity() {
      return [];
    },
    async inspectHost() {
      return [];
    },
    async inspectProxy() {
      return {
        proxyFile: join(root, "Caddyfile"),
        routes: 0,
        state: "unpublished" as const,
      };
    },
    store,
    documents: {
      async read(path: string) {
        return {
          path: `${path}/rig.yaml`,
          revision: "abc",
          config: options.config,
        };
      },
      async discover(path: string) {
        return {
          repoPath: path,
          document: await this.read(path),
          gitRequired: false,
        };
      },
      async identifyInitialization(path: string) {
        return {
          repoPath: path,
          name: options.config.name,
          configPath: `${path}/rig.yaml`,
        };
      },
      async initialize(path: string) {
        return await this.read(path);
      },
      resolve: (input: Parameters<typeof resolveTargetPlan>[0]) =>
        resolveTargetPlan(
          { ...input, config: planConfig(input.config) },
          { operatorHome: "/home/operator", envRoot: join(root, "env") },
        ),
      async host() {
        return parseHostConfig({});
      },
    },
    lifecycle: createTargetLifecycle(
      effects,
      timing,
      options.lifecycleObserver,
    ),
    observations: effects.observations,
    observationBudgetMs: 2000,
    observationDeadline: timerObservationDeadline,
    files: {
      /** Every Service gets the port it declares. */
      async selectPorts(input: {
        requests: { name: string; preferred?: number }[];
      }) {
        return Object.fromEntries(
          input.requests.map((request) => [request.name, request.preferred!]),
        );
      },
    },
    now: () => new Date(clock.ms).toISOString(),
    id: () => `id${++id}`,
    async diagnostic() {},
    ...options.dependencies?.({ root, store }),
  } as unknown as RuntimeDependencies;
  return {
    root,
    repo,
    clock,
    timing,
    store,
    deps,
    /** A daemon over this world: a new one over the same state file and processes stands for a restarted rigd. */
    open: () => createRuntime(deps),
  };
}
