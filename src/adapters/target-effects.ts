import {
  appendFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { InstalledComponent, ManagedComponent } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import type {
  Supervisor,
  CommandRunner,
  CommandResult,
} from "../providers/contracts";
import { isSourceEntrypoint } from "../providers/artifact-installer";
import type { ArtifactInstaller } from "../providers/artifact-installer";
import type { Router } from "../providers/caddy-router";
import type { TargetEffects } from "../runtime/lifecycle";
import type { ObservationEffects } from "../runtime/status";
import { RigError } from "../domain/errors";
import { atomicFile, createArtifactOwnership } from "./artifact-ownership";
import { createEffectTransactions } from "./effect-transactions";
export interface TargetAdapterOptions {
  root: string;
  /** Acquires an ISO timestamp per recorded output entry, after buffered execution. */
  recordingTime: () => string;
  supervisors: ReadonlyMap<string, Supervisor>;
  run: CommandRunner;
  installer: ArtifactInstaller;
  router: Router;
  environment: Readonly<Record<string, string>>;
}
export function installedPath(
  root: string,
  target: TargetRecord,
  component: InstalledComponent,
): string {
  const suffix =
    target.kind === "local"
      ? "-dev"
      : target.kind === "preview"
        ? `-${target.name}`
        : "";
  return join(
    root,
    "bin",
    `${component.installName ?? component.name}${suffix}`,
  );
}
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
        "Select an installed provider in Project configuration.",
      );
    return provider;
  };
  const environment = async (
    target: TargetRecord,
    component?: ManagedComponent | InstalledComponent,
  ): Promise<Record<string, string>> => {
    const file = component?.envFile ?? target.plan.envFile;
    return {
      ...options.environment,
      ...(file ? await readEnvironment(file) : {}),
      ...target.plan.env,
      ...component?.env,
    };
  };
  const runTarget = async (
    command: string,
    target: TargetRecord,
    env: Record<string, string>,
    signal?: AbortSignal,
    timeoutMs = 120000,
    componentName = "setup",
  ) => {
    const result = await options.run({
      command: ["/bin/sh", "-c", command],
      cwd: target.plan.workspacePath,
      env,
      signal,
      timeoutMs,
    });
    await recordOutput(result, target, componentName);
    return result;
  };
  const recordOutput = async (
    result: CommandResult,
    target: TargetRecord,
    componentName: string,
  ) => {
    await mkdir(target.logRoot, { recursive: true, mode: 0o700 });
    const entries = (["stdout", "stderr"] as const).flatMap((stream) =>
      result[stream]
        .split("\n")
        .filter((line, index, lines) => index < lines.length - 1 || line !== "")
        .map((line) =>
          JSON.stringify({
            timestamp: options.recordingTime(),
            component: componentName,
            stream,
            line,
          }),
        ),
    );
    if (entries.length)
      await appendFile(
        join(target.logRoot, "target.jsonl"),
        entries.join("\n") + "\n",
        { mode: 0o600 },
      );
  };
  const health = async (
    component: ManagedComponent,
    target: TargetRecord,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!component.health) return false;
    try {
      if (/^https?:\/\//.test(component.health)) {
        const response = await fetch(component.health, {
          signal,
          redirect: "error",
        });
        await response.body?.cancel();
        return response.ok;
      }
      const result = await options.run({
        command: ["/bin/sh", "-c", component.health],
        cwd: target.plan.workspacePath,
        env: await environment(target, component),
        signal,
        timeoutMs: 2000,
      });
      return result.exitCode === 0;
    } catch (error) {
      if (signal.aborted) throw error;
      return false;
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
      });
      try {
        for (const path of [destination, ownerFile, receiptFile])
          await rm(path, { force: true });
      } finally {
        await transactions.captureArtifact(target.id, [
          destination,
          ownerFile,
          receiptFile,
        ]);
      }
    }
  };
  return {
    supervisor,
    environment,
    health,
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
        if (component.uses === "sqlite") {
          const file = await open(component.path, "a", 0o600);
          await file.close();
        }
        if (
          component.uses === "postgres" &&
          !(await exists(join(component.dataDir, "PG_VERSION")))
        ) {
          const result = await options.run({
            command: [
              "initdb",
              "-D",
              component.dataDir,
              "-A",
              "trust",
              "--no-locale",
            ],
            env: options.environment,
          });
          await recordOutput(result, target, component.name);
          if (result.exitCode)
            throw new RigError(
              "POSTGRES_INIT",
              "Postgres storage could not be initialized.",
              "Install Postgres tools and inspect Target setup logs.",
            );
        }
      }
      if (target.kind === "local") return;
      const marker = join(
        options.root,
        "prepared",
        createHash("sha256").update(target.plan.workspacePath).digest("hex"),
      );
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
        const result = await runTarget(
          command.join(" "),
          target,
          await environment(target),
          undefined,
          600000,
        );
        if (result.exitCode)
          throw new RigError(
            "DEPENDENCIES_FAILED",
            "Project dependency installation failed.",
            "Inspect Target setup logs and retry deployment.",
          );
      }
      await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
      await writeFile(marker, "prepared\n", { mode: 0o600 });
    },
    async hook(command, target, component) {
      const result = await runTarget(
        command,
        target,
        await environment(target, component),
        undefined,
        120000,
        component?.name ?? "setup",
      );
      if (result.exitCode)
        throw new RigError(
          "HOOK_FAILED",
          "A lifecycle hook failed.",
          "Inspect Target setup logs.",
          { exitCode: result.exitCode },
        );
    },
    async install(component, target) {
      const destination = installedPath(options.root, target, component),
        source = resolve(target.plan.workspacePath, component.entrypoint);
      const identity = {
        targetId: target.id,
        componentName: component.name,
        destination,
      };
      await ownership.inspect(identity);
      const env = await environment(target, component);
      const key = installationPolicyKey(
        target.plan.workspacePath,
        component,
        destination,
        env,
      );
      const receiptFile = receiptPath(target, component);
      const receipt = await readInstallReceipt(receiptFile);
      if (
        receipt?.key === key &&
        (await options.installer.observe(destination)) === "installed" &&
        (await installedSourceRevision(source)) === receipt.sourceRevision &&
        (await digestFile(destination)) === receipt.installedRevision
      )
        return { outcome: "unchanged" };
      if (component.build) {
        const result = await runTarget(
          component.build,
          target,
          env,
          undefined,
          600000,
          component.name,
        );
        if (result.exitCode)
          throw new RigError(
            "BUILD_FAILED",
            `The ${component.name} build failed.`,
            "Inspect Target logs; the previous installed artifact is unchanged.",
            { exitCode: result.exitCode },
          );
      }
      try {
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
      } finally {
        await transactions.captureArtifact(target.id, [
          destination,
          ownership.ownerPath(destination),
          receiptFile,
        ]);
      }
      return { outcome: "installed" };
    },
    async route(target) {
      try {
        if (!target.plan.domain || !target.plan.proxy) {
          await options.router.remove(target.id);
          return;
        }
        const component = target.plan.components.find(
          (c) => c.name === target.plan.proxy!.upstream,
        );
        if (component?.kind !== "managed")
          throw new RigError(
            "ROUTE_UPSTREAM",
            "The route upstream is not a managed Component.",
            "Correct the Project proxy configuration.",
          );
        await options.router.apply({
          key: target.id,
          hostname: target.plan.domain,
          upstream: `127.0.0.1:${component.port}`,
        });
      } finally {
        await transactions.captureRoute(target.id);
      }
    },
    async removeRoute(target) {
      try {
        await options.router.remove(target.id);
      } finally {
        await transactions.captureRoute(target.id);
      }
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
            await environment(target, component),
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
/** dotenv-style single-line assignments; unsupported syntax fails instead of silently altering secrets. */
async function readEnvironment(path: string): Promise<Record<string, string>> {
  const text = await readFile(path, "utf8"),
    values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match)
      throw new RigError(
        "ENV_FILE",
        "An environment file contains an unsupported assignment.",
        "Use one KEY=value assignment per line.",
        { path },
      );
    let value = match[2]!.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]!;
      if (!value.endsWith(quote))
        throw new RigError(
          "ENV_FILE",
          "An environment value has an unmatched quote.",
          "Use single-line quoted values.",
          { path },
        );
      value = value.slice(1, -1);
      if (quote === '"')
        value = value
          .replaceAll("\\n", "\n")
          .replaceAll("\\r", "\r")
          .replaceAll('\\"', '"')
          .replaceAll("\\\\", "\\");
    } else value = value.replace(/\s+#.*$/, "").trimEnd();
    values[match[1]!] = value;
  }
  return values;
}

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

function installationPolicyKey(
  workspace: string,
  component: Pick<InstalledComponent, "entrypoint" | "build">,
  destination: string,
  env: Readonly<Record<string, string>>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspace,
        entrypoint: component.entrypoint,
        build: component.build,
        destination,
        env,
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
