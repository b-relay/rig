import {
  access,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  MIGRATED_STATE_VERSION,
  STATE_VERSION,
  runtimeStateSchema as schema,
} from "./state-schema";
import { WORKING_TOOL_SUFFIX } from "../config/schema";
import { RigError, describeInvalidDocument } from "../domain/errors";
import type { RuntimeState, StateStore } from "../domain/runtime";

/** Filesystem Adapter; caller supplies isolated root. One daemon is the writer. */
export class FileStateStore implements StateStore {
  private queue: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(private readonly root: string) {
    this.path = join(root, "runtime", "state.json");
  }

  async read(): Promise<RuntimeState> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          version: STATE_VERSION,
          projects: [],
          targets: [],
          activity: [],
        };
      }
      throw new RigError(
        "STATE_READ",
        "Unable to read runtime state.",
        "Check state directory permissions.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      this.assertSupportedVersion(parsed);
      readFixedTargetNames(parsed);
      schema.parse(parsed);
    } catch (error) {
      if (error instanceof RigError) throw error;
      const backup = (await exists(this.backupPath))
        ? this.backupPath
        : undefined;
      throw new RigError(
        "STATE_CORRUPT",
        "Invalid runtime state; nothing was changed.",
        `Runtime state at ${this.path} ${describeInvalidDocument(error, "runtime state")}. ${
          backup
            ? `The previous version is kept at ${backup}; copy it back over the file, or repair the file by hand, before retrying.`
            : "Repair the file by hand, or restore it from your own backup, before retrying."
        }`,
        {
          path: this.path,
          ...(backup ? { backupPath: backup } : {}),
          ...(error instanceof z.ZodError
            ? { issues: error.issues.slice(0, 3) }
            : {}),
        },
      );
    }
    // The validated document is returned as read, not as the schema's stripped copy: keys a newer rigd
    // wrote survive a round trip through this one, and the next write carries them along.
    const state = parsed as RuntimeState;
    readRetiredSupervisorAsRigd(state);
    forgetOngoingHealthChecks(state);
    forgetOperatorAlerts(state);
    readEnvironmentSources(state);
    return { ...state, version: STATE_VERSION };
  }
  /** A file from a different rigd is refused by version before its shape is judged. */
  private assertSupportedVersion(parsed: unknown): void {
    const version =
      typeof parsed === "object" && parsed !== null && "version" in parsed
        ? parsed.version
        : undefined;
    if (
      typeof version !== "number" ||
      version === STATE_VERSION ||
      version === MIGRATED_STATE_VERSION
    )
      return;
    const newer = version > STATE_VERSION;
    throw new RigError(
      "STATE_VERSION",
      `Runtime state was written by ${newer ? "a newer" : "an older"} rigd; nothing was changed.`,
      `Runtime state at ${this.path} is version ${version}, but this rigd reads version ${STATE_VERSION}. ${newer ? "Upgrade rigd" : "Use the rigd that wrote it"}, or restore the state that version ${STATE_VERSION} wrote, before retrying.`,
      { path: this.path, version, supported: STATE_VERSION },
    );
  }

  /** Durable replace: the new state is flushed to disk before it becomes `state.json`, and the version it
   * replaces stays readable as `state.json.bak` (one generation). */
  update(change: (state: RuntimeState) => void | Promise<void>): Promise<void> {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      await change(state);
      schema.parse(state);
      const directory = join(this.root, "runtime");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.next`;
      try {
        await writeDurably(temporary, `${JSON.stringify(state, null, 2)}\n`);
        await keepPreviousGeneration(this.path, this.backupPath);
        await rename(temporary, this.path);
        await syncDirectory(directory);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private get backupPath(): string {
    return `${this.path}.bak`;
  }
}
type Loose = Record<string, unknown>;
const loose = (value: unknown): value is Loose =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const ROLE_OF_KIND: Readonly<Record<string, "working" | "stable">> = {
  local: "working",
  live: "stable",
};
/** Names a Preview may no longer have: the working and stable Targets' names, and the working Target's Tool suffix. */
const RESERVED_NAMES: readonly string[] = [
  "working",
  "stable",
  WORKING_TOOL_SUFFIX,
];
/** State version 4 recorded the working and stable Targets with the kinds `local` and `live`, under the names `local` and
 * `live` or whatever rig.yaml renamed them to (Pantry's working Target was `dev`). Names are fixed now, so such a file is
 * read with each kind and name made its role, `working` or `stable`, and saved so by the next write. It runs before
 * validation, on the parsed JSON, and changes nothing it does not recognize, so a malformed file still fails validation.
 * - The working and stable Targets always take their role's name. A Preview an explicit --deployment named `working`,
 *   `stable` or `dev` is renamed `<name>-preview` (with `-2`, `-3`, ... if that is taken too), so no two Targets of a
 *   Project share a name.
 * - The plans' names follow, but their recorded domains and routes stay as they were served: the route is keyed by the
 *   Target's id, so the next plan replaces it.
 * - A Tool a renamed Target published under its old name (`<tool>-<old name>`; the stable Target's plain name never
 *   changes) is recorded as `publishedAs`, so status still finds it and planning the Target again retires it instead of
 *   leaving it behind.
 * Activity keeps the old names as the text it recorded. */
export function readFixedTargetNames(parsed: unknown): void {
  if (!loose(parsed) || parsed.version !== MIGRATED_STATE_VERSION) return;
  parsed.version = STATE_VERSION;
  const targets = (Array.isArray(parsed.targets) ? parsed.targets : []).filter(
    loose,
  );
  const taken = new Set(
    targets.map((target) => `${target.projectId}:${target.name}`),
  );
  for (const target of targets) {
    const role = ROLE_OF_KIND[String(target.kind)];
    if (role) {
      renameTarget(target, role, role);
      taken.add(`${target.projectId}:${role}`);
    } else if (
      target.kind === "preview" &&
      typeof target.name === "string" &&
      RESERVED_NAMES.includes(target.name)
    ) {
      let name = `${target.name}-preview`;
      for (let n = 2; taken.has(`${target.projectId}:${name}`); n++)
        name = `${target.name}-preview-${n}`;
      taken.add(`${target.projectId}:${name}`);
      renameTarget(target, "preview", name);
    }
  }
}
/** One record of state version 4 under its new kind and name: its plans' names follow, and a Tool it published under its old
 * name keeps that file name as `publishedAs`. */
function renameTarget(
  target: Loose,
  kind: "working" | "stable" | "preview",
  name: string,
): void {
  const old = target.name;
  target.kind = kind;
  target.name = name;
  const recovery = loose(target.recovery) ? target.recovery : {};
  for (const plan of [target.plan, recovery.plan]) {
    if (!loose(plan)) continue;
    if (plan.target === "local" || plan.target === "live") plan.target = kind;
    for (const field of ["deploymentName", "branchSlug", "subdomain"])
      if (plan[field] === old) plan[field] = name;
    // The stable Target published the plain name before and still does; the others carried their old name.
    if (kind === "stable" || typeof old !== "string") continue;
    const suffix = kind === "working" ? WORKING_TOOL_SUFFIX : name;
    if (old === suffix) continue;
    for (const component of Array.isArray(plan.components)
      ? plan.components
      : []) {
      if (!loose(component) || component.kind !== "installed") continue;
      const base = component.installName ?? component.name;
      if (component.publishedAs === undefined && typeof base === "string")
        component.publishedAs = `${base}-${old}`;
    }
  }
}
/** Rig once offered per-Service launchd supervision, and plans recorded then name `launchd`. rigd supervises every Service
 * now, so such a plan is read as rigd's: its stopped Target starts under rigd, and the plan is not config drift. The next
 * write saves it so. */
function readRetiredSupervisorAsRigd(state: RuntimeState): void {
  for (const target of state.targets)
    for (const plan of [target.plan, target.recovery?.plan])
      if (plan?.providers.processSupervisor === "launchd")
        plan.providers.processSupervisor = "rigd";
}
/** Rig once ran ongoing health checks, and plans recorded then may carry a Service's `healthMonitor` and a run its
 * `healthRestarts`. Only start readiness remains, so both are dropped as the state is read: such a plan equals the plan its
 * config makes today and is not config drift. The next write saves it so. */
function forgetOngoingHealthChecks(state: RuntimeState): void {
  for (const target of state.targets) {
    for (const plan of [target.plan, target.recovery?.plan])
      for (const component of plan?.components ?? [])
        delete (component as { healthMonitor?: unknown }).healthMonitor;
    for (const run of Object.values(target.services ?? {}))
      delete (run as { healthRestarts?: unknown }).healthRestarts;
  }
}
/** Rig once sent operator alerts about Stable Targets that stayed down, and kept what it had alerted about under
 * `alerts`. It sends none now, so the key is dropped as the state is read rather than carried along as a newer rigd's
 * key would be. The next write saves it so. */
function forgetOperatorAlerts(state: RuntimeState): void {
  delete (state as { alerts?: unknown }).alerts;
}
/** A plan names each public value a command was built from by its config path. Before ADR 0011 renamed `env` to
 * `environment`, those paths read `env.NAME` and `services.<name>.env.NAME`; they are read under the new name, so such a
 * plan equals the plan its config makes today and is not config drift. The next write saves it so. */
function readEnvironmentSources(state: RuntimeState): void {
  for (const target of state.targets)
    for (const plan of [target.plan, target.recovery?.plan])
      for (const unit of [...(plan?.components ?? []), ...(plan?.builds ?? [])])
        for (const input of unit.commandInputs ?? [])
          input.source = input.source.replace(
            /^((?:services\.[^.]+\.)?)env\./,
            "$1environment.",
          );
}
async function writeDurably(path: string, content: string): Promise<void> {
  const file = await open(path, "w", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}
/** Point `backup` at the bytes currently published at `path`; a first write has nothing to keep. */
async function keepPreviousGeneration(
  path: string,
  backup: string,
): Promise<void> {
  if (!(await exists(path))) return;
  await rm(backup, { force: true });
  await link(path, backup);
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** The first thing wrong with a state file, worded so the user can open it and look. */
