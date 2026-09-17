import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { createHash } from "node:crypto";
import type {
  BuildUnit,
  InstalledComponent,
  ManagedComponent,
} from "../config/types";
import { isHealthUrl } from "../config/schema";
import { gitIgnoreCheck, loadEnvironmentFiles } from "./env-file";
import { composeEnvironment } from "../domain/process-environment";
import type { TargetRecord } from "../domain/runtime";
import type {
  Supervisor,
  CommandRunner,
  CommandResult,
  HealthCheck,
  TargetLogEntry,
} from "../providers/contracts";
import { isSourceEntrypoint } from "../providers/artifact-installer";
import type { ArtifactInstaller } from "../providers/artifact-installer";
import type { Router } from "../providers/caddy-router";
import type { ListenerInspection } from "../providers/listener-inspection";
import type { PortProbe } from "../providers/port-probe";
import { declaredPorts, plannedRoutes } from "../runtime/ports";
import type { TargetEffects } from "../runtime/lifecycle";
/** The last non-empty output line, trimmed to fit one log line, or undefined. */
function lastLine(output: string): string | undefined {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  return lines.length
    ? lines[lines.length - 1]!.trim().slice(0, 160)
    : undefined;
}
/** A probe transport failure named by its error code when it has one, else its message. */
function failureReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code ? code : error.message;
  }
  return String(error);
}
import type { ObservationEffects } from "../runtime/status";
import { RigError, failureCauses } from "../domain/errors";
import { atomicFile, createArtifactOwnership } from "./artifact-ownership";
import { createEffectTransactions } from "./effect-transactions";
import { appendTargetLog } from "../providers/target-log";
export interface TargetAdapterOptions {
  root: string;
  /** Acquires an ISO timestamp per recorded output entry, after buffered execution. */
  recordingTime: () => string;
  supervisors: ReadonlyMap<string, Supervisor>;
  run: CommandRunner;
  installer: ArtifactInstaller;
  router: Router;
  /** Asks whether a declared port accepts connections; `probeLocalPort` on the platform. */
  connect: PortProbe;
  listeners: ListenerInspection;
  environment: Readonly<Record<string, string>>;
}
export function installedPath(
  root: string,
  target: TargetRecord,
  component: InstalledComponent,
): string {
  // The Stable Target owns the plain command; every other Target's alias carries its own name.
  const suffix = target.kind === "live" ? "" : `-${target.name}`;
  return join(
    root,
    "bin",
    `${component.installName ?? component.name}${suffix}`,
  );
}
/** Budgets in seconds when the Project config declares none. */
const DEFAULT_HOOK_TIMEOUT_SECONDS = 120;
const DEFAULT_INSTALL_TIMEOUT_SECONDS = 600;
/** Owns target-specific filesystem and process effects. Orchestration policy lives in lifecycle. */
export function createTargetEffects(
  options: TargetAdapterOptions,
): TargetEffects & { observations: ObservationEffects } {
  const ownership = createArtifactOwnership(options.root);
  const transactions = createEffectTransactions({
    root: options.root,
    ownership,
    router: options.router,
  });
  const receiptPath = (target: TargetRecord, component: InstalledComponent) =>
    join(
      options.root,
      "installed",
      createHash("sha256")
        .update(`${target.id}:${component.name}`)
        .digest("hex") + ".json",
    );
  const supervisor = (target: TargetRecord) => {
    const provider = options.supervisors.get(
      target.plan.providers.processSupervisor,
    );
    if (!provider)
      throw new RigError(
        "PROVIDER_MISSING",
        `Process supervisor '${target.plan.providers.processSupervisor}' is unavailable.`,
        `Set providers.processSupervisor to one of ${[...options.supervisors.keys()].join(", ")} in Project configuration.`,
      );
    return provider;
  };
  const ignored = gitIgnoreCheck(options.run, options.environment);
  const noted = new Set<string>();
  /** One invocation's environment, composed fresh each time: the controlled baseline with a Target-owned TMPDIR, the scope's public env, then its env files.
   * Overrides and permission warnings go to the Target log by name; file values go nowhere but the returned environment. */
  const environment = async (
    target: TargetRecord,
    component?: ManagedComponent | InstalledComponent,
    /** Inputs of a Project-scope command, which no Component carries. */
    projectInputs: NonNullable<BuildUnit["commandInputs"]> = [],
  ): Promise<Record<string, string>> => {
    const scope = component ?? target.plan;
    const loaded = await loadEnvironmentFiles(
      scope.envFiles ?? [],
      target.plan.workspacePath,
      ignored,
    );
    const tmp = join(options.root, "tmp", target.id);
    const composed = composeEnvironment({
      baseline: { ...options.environment, TMPDIR: tmp },
      publicEnv: scope.env ?? {},
      files: loaded.files,
      guarded: component?.commandInputs ?? projectInputs,
      ...(component ? { component: component.name } : {}),
    });
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const notes = [
      ...loaded.warnings,
      ...composed.overrides.map(
        (override) =>
          `Environment name ${override.key} comes from ${override.sources.at(-1)}, overriding ${override.sources.slice(0, -1).join(", ")}.`,
      ),
    ];
    // Readiness polls compose too; a note is evidence once per Target, not once per poll.
    const fresh = notes.filter((note) => !noted.has(`${target.id}:${note}`));
    for (const note of fresh) noted.add(`${target.id}:${note}`);
    if (fresh.length)
      await recordLines(target, component?.name ?? "setup", "stderr", fresh);
    return composed.env;
  };
  /** Runs a shell command in the Target workspace within a budget in seconds and records its output,
   * including what a killed command printed before its budget ran out, under the Component name. */
  const runTarget = async (
    command: string,
    target: TargetRecord,
    env: Record<string, string>,
    timeoutSeconds: number,
    componentName = "setup",
  ) => {
    const live = liveRecorder(target, componentName);
    const result = await options.run({
      command: ["/bin/sh", "-c", command],
      cwd: target.plan.workspacePath,
      env,
      timeoutMs: timeoutSeconds * 1000,
      onOutput: live.receive,
    });
    // A runner that does not stream hands over its whole output at the end instead.
    if (!(await live.finish()))
      await recordOutput(result, target, componentName);
    return result;
  };
  /** Records complete lines as a running command produces them, each at the time it was seen;
   * finish flushes a trailing partial line and says whether anything was streamed. */
  const liveRecorder = (target: TargetRecord, componentName: string) => {
    const pending = { stdout: "", stderr: "" };
    let streamed = false;
    let writes: Promise<void> = Promise.resolve();
    const receive = (stream: "stdout" | "stderr", chunk: string) => {
      streamed = true;
      const text = pending[stream] + chunk;
      const lines = text.split("\n");
      pending[stream] = lines.pop() ?? "";
      if (lines.length)
        writes = writes.then(() =>
          recordLines(target, componentName, stream, lines),
        );
    };
    const finish = async () => {
      for (const stream of ["stdout", "stderr"] as const)
        if (pending[stream])
          writes = writes.then(() =>
            recordLines(target, componentName, stream, [pending[stream]]),
          );
      await writes;
      return streamed;
    };
    return { receive, finish };
  };
  const recordOutput = async (
    result: CommandResult,
    target: TargetRecord,
    componentName: string,
  ) => {
    for (const stream of ["stdout", "stderr"] as const)
      await recordLines(
        target,
        componentName,
        stream,
        result[stream]
          .split("\n")
          .filter(
            (line, index, lines) => index < lines.length - 1 || line !== "",
          ),
      );
  };
  const recordLines = async (
    target: TargetRecord,
    componentName: string,
    stream: TargetLogEntry["stream"],
    lines: readonly string[],
  ) => {
    if (!lines.length) return;
    await appendTargetLog(
      target.logRoot,
      lines
        .map((line) =>
          JSON.stringify({
            timestamp: options.recordingTime(),
            component: componentName,
            stream,
            line,
          }),
        )
        .join("\n") + "\n",
    );
  };
  /** Last recorded probe evidence per Target Component, so the Target log holds each change rather than every poll. */
  const lastHealth = new Map<string, string>();
  const health = async (
    component: ManagedComponent,
    target: TargetRecord,
    signal: AbortSignal,
  ): Promise<HealthCheck> => {
    const check = component.health
      ? await probe(component, target, signal)
      : await connections(component, signal);
    const evidence = check.ready ? "ready" : check.reason;
    const key = `${target.id}:${component.name}`;
    if (lastHealth.get(key) !== evidence) {
      lastHealth.set(key, evidence);
      await recordLines(target, component.name, "health", [evidence]);
    }
    return check;
  };
  /** Without a check of its own a Service is ready once every port it declares accepts a connection. */
  const connections = async (
    component: ManagedComponent,
    signal: AbortSignal,
  ): Promise<HealthCheck> => {
    const ports = Object.entries(declaredPorts(component));
    if (!ports.length) return { ready: false, reason: "no health check" };
    for (const [name, port] of ports) {
      const check = await options.connect(port, signal);
      if (!check.ready)
        return { ready: false, reason: `${name}: ${check.reason}` };
    }
    return { ready: true };
  };
  /** An HTTP answer below 400, a redirect included, means the process is serving; a shell probe passes on exit 0. */
  const probe = async (
    component: ManagedComponent,
    target: TargetRecord,
    signal: AbortSignal,
  ): Promise<HealthCheck> => {
    try {
      if (isHealthUrl(component.health!)) {
        const response = await fetch(component.health!, {
          signal,
          redirect: "manual",
        });
        await response.body?.cancel();
        return response.status < 400
          ? { ready: true }
          : { ready: false, reason: `HTTP ${response.status}` };
      }
      const result = await options.run({
        command: ["/bin/sh", "-c", component.health!],
        cwd: target.plan.workspacePath,
        env: await environment(target, component),
        signal,
        timeoutMs: 2000,
      });
      if (result.exitCode === 0) return { ready: true };
      const detail = lastLine(result.stderr) ?? lastLine(result.stdout);
      return {
        ready: false,
        reason: `${result.timedOut ? "timed out after 2s" : `exit code ${result.exitCode}`}${detail ? `: ${detail}` : ""}`,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return { ready: false, reason: failureReason(error) };
    }
  };
  const installedComponents = (target: TargetRecord) =>
    target.plan.components.filter(
      (component): component is InstalledComponent =>
        component.kind === "installed",
    );
  const superseded = (previous: TargetRecord, candidate: TargetRecord) => {
    const retained = new Set(
      installedComponents(candidate).map((component) =>
        installedPath(options.root, candidate, component),
      ),
    );
    return installedComponents(previous).filter(
      (component) =>
        !retained.has(installedPath(options.root, previous, component)),
    );
  };
  const retireComponents = async (
    target: TargetRecord,
    components: readonly InstalledComponent[],
  ) => {
    for (const component of components) {
      if (component.kind !== "installed") continue;
      const destination = installedPath(options.root, target, component),
        ownerFile = ownership.ownerPath(destination),
        receiptFile = receiptPath(target, component);
      await ownership.inspect({
        targetId: target.id,
        componentName: component.name,
        destination,
        project: target.plan.project,
        target: target.name,
      });
      await transactions.withArtifactChange(
        target.id,
        [destination, ownerFile, receiptFile],
        async () => {
          for (const path of [destination, ownerFile, receiptFile])
            await rm(path, { force: true });
        },
      );
    }
  };
  return {
    supervisor,
    environment,
    health,
    pruneCheckpoints: (live) => transactions.pruneCheckpoints(live),
    checkpoint: (target, previous) =>
      transactions.checkpoint(
        target.id,
        [
          ...installedComponents(target).map((component) => ({
            target,
            component,
          })),
          ...(previous
            ? superseded(previous, target).map((component) => ({
                target: previous,
                component,
              }))
            : []),
        ].map(({ target: owner, component }) => ({
          targetId: owner.id,
          componentName: component.name,
          destination: installedPath(options.root, owner, component),
          receiptPath: receiptPath(owner, component),
          project: owner.plan.project,
          target: owner.name,
        })),
      ),
    commitEffects: (target) => transactions.commit(target.id),
    restoreEffects: (target) => transactions.restore(target.id),
    retireArtifacts: (target) =>
      retireComponents(target, installedComponents(target)),
    retireSuperseded: (previous, candidate) =>
      retireComponents(previous, superseded(previous, candidate)),
    async prepare(target) {
      await mkdir(target.logRoot, { recursive: true, mode: 0o700 });
      for (const component of target.plan.preparedComponents) {
        const directory =
          component.uses === "sqlite"
            ? dirname(component.path)
            : component.uses === "convex"
              ? component.stateDir
              : component.dataDir;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (component.uses === "convex")
          await linkConvexState(target.plan.workspacePath, component.stateDir);
        if (component.uses === "sqlite") {
          const file = await open(component.path, "a", 0o600);
          await file.close();
        }
        if (
          component.uses === "postgres" &&
          !(await exists(join(component.dataDir, "PG_VERSION")))
        ) {
          let result;
          try {
            result = await options.run({
              command: [
                "initdb",
                "-E",
                "UTF8",
                "-A",
                "trust",
                "--no-locale",
                "-D",
                component.dataDir,
              ],
              env: options.environment,
            });
          } catch (error) {
            if (!(error instanceof RigError) || error.code !== "COMMAND_START")
              throw error;
            throw new RigError(
              "POSTGRES_INIT",
              `initdb is not installed or not on rigd's PATH, so the Postgres storage for ${component.name} could not be initialized.`,
              "Install PostgreSQL (for example brew install postgresql@17) so initdb, postgres and pg_isready are on the PATH rigd was installed from, then retry.",
              { component: component.name },
              failureCauses(error),
            );
          }
          await recordOutput(result, target, component.name);
          if (result.exitCode)
            throw new RigError(
              "POSTGRES_INIT",
              `initdb exited with code ${result.exitCode}, so the Postgres storage for ${component.name} could not be initialized.`,
              "Inspect the Target setup logs for initdb's output.",
              { component: component.name, exitCode: result.exitCode },
            );
        }
      }
      if (target.kind === "local") return;
      // The marker lives in the immutable workspace, so releasing the revision reclaims it too.
      const marker = join(target.plan.workspacePath, PREPARED_MARKER);
      if (await exists(marker)) return;
      // Dependency installation happens once per immutable workspace. Application builds remain Component policy.
      let command: string[] | undefined;
      if (
        (await exists(join(target.plan.workspacePath, "bun.lock"))) ||
        (await exists(join(target.plan.workspacePath, "bun.lockb")))
      )
        command = ["bun", "install", "--frozen-lockfile"];
      else if (
        await exists(join(target.plan.workspacePath, "package-lock.json"))
      )
        command = ["npm", "ci"];
      else if (await exists(join(target.plan.workspacePath, "pnpm-lock.yaml")))
        command = ["pnpm", "install", "--frozen-lockfile"];
      else if (await exists(join(target.plan.workspacePath, "yarn.lock")))
        command = ["yarn", "install", "--frozen-lockfile"];
      else if (await exists(join(target.plan.workspacePath, "package.json")))
        command = ["bun", "install"];
      if (command) {
        const timeoutSeconds =
          target.plan.installTimeout ?? DEFAULT_INSTALL_TIMEOUT_SECONDS;
        const result = await runTarget(
          command.join(" "),
          target,
          await environment(target),
          timeoutSeconds,
        );
        if (result.timedOut)
          throw new RigError(
            "DEPENDENCIES_TIMEOUT",
            `Project dependency installation (${command.join(" ")}) did not finish within ${timeoutSeconds} s and was killed.`,
            "Inspect Target setup logs for its output so far; set installTimeout in the Project config if it needs longer.",
            { command: command.join(" "), timeoutSeconds },
          );
        if (result.exitCode)
          throw new RigError(
            "DEPENDENCIES_FAILED",
            "Project dependency installation failed.",
            "Inspect Target setup logs and retry deployment.",
          );
      }
      await writeFile(marker, "prepared\n", { mode: 0o600 });
    },
    async hook(command, target, component, name) {
      const timeoutSeconds =
        component?.hookTimeout ??
        target.plan.hookTimeout ??
        DEFAULT_HOOK_TIMEOUT_SECONDS;
      const result = await runTarget(
        command,
        target,
        await environment(target, component),
        timeoutSeconds,
        component?.name ?? "setup",
      );
      if (result.timedOut)
        throw new RigError(
          "HOOK_TIMEOUT",
          `Hook ${name} for ${component ? component.name : "the Project"} did not finish within ${timeoutSeconds} s and was killed.`,
          `Inspect the ${component?.name ?? "setup"} Target logs for its output so far; set hookTimeout on the ${component ? "Component" : "Project"} if it needs longer.`,
          {
            hook: name,
            ...(component ? { component: component.name } : {}),
            timeoutSeconds,
          },
        );
      if (result.exitCode)
        throw new RigError(
          "HOOK_FAILED",
          `Hook ${name} for ${component ? component.name : "the Project"} exited with code ${result.exitCode}.`,
          `Inspect the ${component?.name ?? "setup"} Target logs.`,
          {
            hook: name,
            ...(component ? { component: component.name } : {}),
            exitCode: result.exitCode,
          },
        );
    },
    async build(unit, target) {
      const component = target.plan.components.find(
        (candidate) => candidate.name === unit.component,
      );
      if (unit.component !== undefined && !component)
        throw new RigError(
          "BUILD_SCOPE",
          `Build unit ${unit.id} names no Component of this plan.`,
          "Deploy again so the plan and its build units are recorded together.",
          { unit: unit.id },
        );
      const name = unit.component ?? "setup";
      const result = await runTarget(
        unit.command,
        target,
        await environment(
          target,
          component?.kind === "persistent" ? undefined : component,
          unit.commandInputs,
        ),
        unit.timeout,
        name,
      );
      const label =
        unit.component === undefined ? "shared" : `${unit.component}`;
      if (result.timedOut)
        throw new RigError(
          "BUILD_TIMEOUT",
          `The ${label} build did not finish within ${unit.timeout} s and was killed.`,
          `Inspect the ${name} Target logs for its output so far; set build_timeout if it needs longer. Nothing was started or published.`,
          { unit: unit.id, timeoutSeconds: unit.timeout },
        );
      if (result.exitCode)
        throw new RigError(
          "BUILD_FAILED",
          `The ${label} build failed.`,
          `Inspect the ${name} Target logs. Nothing was started or published.`,
          { unit: unit.id, exitCode: result.exitCode },
        );
    },
    async install(component, target) {
      const destination = installedPath(options.root, target, component),
        source = resolve(target.plan.workspacePath, component.entrypoint);
      const identity = {
        targetId: target.id,
        componentName: component.name,
        destination,
        project: target.plan.project,
        target: target.name,
      };
      await ownership.inspect(identity);
      const env = await environment(target, component);
      const key = installationPolicyKey(
        target.plan.workspacePath,
        component,
        destination,
      );
      const receiptFile = receiptPath(target, component);
      const receipt = await readInstallReceipt(receiptFile);
      const published =
        receipt?.key === key &&
        (await options.installer.observe(destination)) === "installed" &&
        (await digestFile(destination)) === receipt.installedRevision;
      const unchanged = async () =>
        published &&
        (await installedSourceRevision(source)) === receipt!.sourceRevision;
      if (await unchanged()) return { outcome: "unchanged" };
      await transactions.withArtifactChange(
        target.id,
        [destination, ownership.ownerPath(destination), receiptFile],
        async () => {
          await ownership.publish(identity, async () => {
            await options.installer.install({
              cwd: target.plan.workspacePath,
              entrypoint: component.entrypoint,
              destination,
              env,
            });
          });
          await writeInstallReceipt(receiptFile, {
            key,
            sourceRevision: (await installedSourceRevision(source))!,
            installedRevision: (await digestFile(destination))!,
          });
        },
      );
      return { outcome: "installed" };
    },
    listeners: (pid, signal) => options.listeners.inspect(pid, signal),
    async route(target, change) {
      if (!target.plan.domain || !target.plan.proxy)
        return transactions.withRouteChange(target.id, () =>
          options.router.remove(target.id),
        );
      const routes = plannedRoutes(target.plan);
      if (!routes.length)
        throw new RigError(
          "ROUTE_UPSTREAM",
          "The route upstream is not a managed Component.",
          "Correct the Project proxy configuration.",
        );
      const domain = target.plan.domain;
      const held = new Set(await options.router.withheld(target.id));
      const withheld = new Set([
        ...routes
          .filter((route) => held.has(route.prefix))
          .map((route) => route.service),
        ...("withhold" in change ? change.withhold : []),
      ]);
      if ("verified" in change)
        for (const service of change.verified) withheld.delete(service);
      await transactions.withRouteChange(target.id, () =>
        options.router.apply({
          key: target.id,
          hostname: domain,
          routes: routes.map((route) => ({
            prefix: route.prefix,
            upstream: withheld.has(route.service)
              ? null
              : `127.0.0.1:${route.port}`,
          })),
        }),
      );
    },
    async removeRoute(target) {
      await transactions.withRouteChange(target.id, () =>
        options.router.remove(target.id),
      );
    },
    observations: {
      process: (target, component, signal) =>
        supervisor(target).observe(`${target.id}:${component.name}`, signal),
      health: (target, component, signal) => health(component, target, signal),
      artifact: async (target, component) => {
        try {
          if (
            isSourceEntrypoint(component.entrypoint) &&
            !(await exists(
              resolve(target.plan.workspacePath, component.entrypoint),
            ))
          )
            return "missing";
          const destination = installedPath(options.root, target, component);
          const owned = await ownership.inspect({
            targetId: target.id,
            componentName: component.name,
            destination,
            project: target.plan.project,
            target: target.name,
          });
          if (owned.revision === undefined) return "missing";
          if (!owned.owner) return "unknown";
          const receipt = await readInstallReceipt(
            receiptPath(target, component),
          );
          const key = installationPolicyKey(
            target.plan.workspacePath,
            component,
            destination,
          );
          if (
            !receipt ||
            receipt.key !== key ||
            receipt.installedRevision !== owned.revision ||
            receipt.sourceRevision !==
              (await installedSourceRevision(
                resolve(target.plan.workspacePath, component.entrypoint),
              ))
          )
            return "unknown";
          return await options.installer.observe(destination);
        } catch {
          return "unknown";
        }
      },
      persistent: (_target, component) => exists(component.path),
    },
  };
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Written at a deployed workspace root once its dependencies are installed. */
const PREPARED_MARKER = ".rig-prepared";
const installReceiptSchema = z.object({
  key: z.string().describe("Digest of recorded installation policy."),
  sourceRevision: z.string().describe("Installed source identity."),
  installedRevision: z.string().describe("Digest of the published artifact."),
});
type InstallReceipt = z.infer<typeof installReceiptSchema>;
async function readInstallReceipt(
  path: string,
): Promise<InstallReceipt | undefined> {
  const raw = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
  try {
    return installReceiptSchema.parse(JSON.parse(raw));
  } catch {
    throw new RigError(
      "INSTALL_RECEIPT",
      "An installed component receipt is corrupt.",
      "Inspect the installation state before retrying.",
      { path },
    );
  }
}
async function writeInstallReceipt(
  path: string,
  receipt: InstallReceipt,
): Promise<void> {
  await atomicFile(path, JSON.stringify(receipt));
}
async function digestFile(path: string): Promise<string | undefined> {
  try {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    return digest.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Keys a publication receipt on the public policy the Project declares: its public env and which env files it names, never their contents,
 * so a secret never reaches a receipt and a changed operator file does not republish a Tool. The baseline (PATH, HOME, ...) is
 * excluded too, so a daemon restarted from another shell does not republish every installed Component. */
function installationPolicyKey(
  workspace: string,
  component: Pick<InstalledComponent, "entrypoint" | "env" | "envFiles">,
  destination: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspace,
        entrypoint: component.entrypoint,
        destination,
        env: component.env,
        envFiles: (component.envFiles ?? []).map((file) => file.path),
      }),
    )
    .digest("hex");
}
async function installedSourceRevision(
  source: string,
): Promise<string | undefined> {
  return isSourceEntrypoint(source)
    ? (await exists(source))
      ? "source-shim"
      : undefined
    : await digestFile(source);
}
/** Convex only knows `<cwd>/.convex/local/default`; a deployed checkout is pointed at the persistent state directory instead of growing its own. */
async function linkConvexState(
  workspacePath: string,
  stateDir: string,
): Promise<void> {
  const expected = join(workspacePath, ".convex", "local", "default");
  if (resolve(stateDir) === expected) return;
  const current = await lstat(expected).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (current?.isSymbolicLink()) {
    if ((await readlink(expected)) === stateDir) return;
    await rm(expected);
  } else if (current)
    throw new RigError(
      "CONVEX_STATE_CONFLICT",
      "The deployment checkout already contains Convex local state.",
      "Remove .convex/local/default from the repository so Rig can keep Convex state in Target storage.",
      { path: expected, stateDir },
    );
  await mkdir(dirname(expected), { recursive: true, mode: 0o700 });
  await symlink(stateDir, expected);
}
