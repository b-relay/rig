import { access, link, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { replacePrivateFile } from "../providers/private-files";
import { z } from "zod";
import {
  MIGRATED_STATE_VERSIONS,
  REDACTED_HEALTH_STATE_VERSION,
  STATE_VERSION,
  UNFIXED_NAMES_STATE_VERSION,
  runtimeStateSchema as schema,
} from "./state-schema";
import { WORKING_TOOL_SUFFIX } from "../config/schema";
import { RigError } from "../domain/errors";
import { describeInvalidDocument } from "../domain/invalid-document";
import type { RuntimeState, StateStore } from "../domain/runtime";

/** A change waiting for the next write, and how to answer its caller once that write is durable or the change is refused. */
interface QueuedChange {
  readonly change: (state: RuntimeState) => void | Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** Filesystem Adapter; caller supplies isolated root. One daemon is the writer. */
export class FileStateStore implements StateStore {
  private readonly path: string;
  /** The file as it last passed validation: rigd reads the state many times a second and it rarely changes. */
  private validated: { revision: string | undefined; raw: string } | undefined;
  /** The one frozen copy readers that change nothing share, and the revision it was read at. */
  private shared:
    { revision: string; state: Promise<RuntimeState> } | undefined;
  /** Changes asked for while a write is under way; the next write takes all of them. */
  private queued: QueuedChange[] = [];
  private writing = false;
  constructor(private readonly root: string) {
    this.path = join(root, "runtime", "state.json");
  }

  /** Every write replaces the file, so a new inode and time; undefined when the file cannot be looked at, or its time is a
   * whole millisecond, as on a filesystem too coarse (HFS+, exFAT) to tell two writes apart. A finer filesystem lands on one
   * about once in a million writes; until the next write, every read then reads the file again and supervision goes without
   * its shared snapshot. */
  revision(): Promise<string | undefined> {
    return revisionOf(this.path);
  }

  /** The state as `read` gives it, frozen through and through and shared by every caller while the file keeps its revision,
   * so a Host's many readers parse it once per write rather than once each. A file whose revision cannot be told is read
   * for each caller. */
  async snapshot(): Promise<RuntimeState> {
    const revision = await this.revision();
    if (revision === undefined) return deepFreeze(await this.read());
    if (this.shared?.revision !== revision) {
      // Read after the revision was taken, so it is at least as new as that revision: a write in between is read again
      // by the next caller, whose revision differs.
      const state = this.read().then(deepFreeze);
      const shared = { revision, state };
      this.shared = shared;
      state.catch(() => {
        if (this.shared === shared) this.shared = undefined;
      });
    }
    return await this.shared.state;
  }

  async read(): Promise<RuntimeState> {
    // Looked at before the file is read: a write in between only makes the next read read it again.
    const revision = await this.revision();
    let raw: string;
    try {
      raw =
        revision !== undefined && revision === this.validated?.revision
          ? this.validated.raw
          : await readFile(this.path, "utf8");
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
      withholdUnredactedHealthOutput(parsed);
      readFixedTargetNames(parsed);
      readEarlierVersions(parsed);
      if (raw !== this.validated?.raw) schema.parse(parsed);
      this.validated = { revision, raw };
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
    forgetRetiredHealthMonitor(state);
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
      MIGRATED_STATE_VERSIONS.includes(version)
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
   * replaces stays readable as `state.json.bak` (one generation). Changes asked for while a write is under way are
   * applied in order to one state and written together: each is validated after it runs, and one that fails or leaves the
   * state invalid is refused alone and leaves nothing behind. Each caller is answered once the write that holds its change is durable. */
  update(change: (state: RuntimeState) => void | Promise<void>): Promise<void> {
    const done = new Promise<void>((resolve, reject) =>
      this.queued.push({ change, resolve, reject }),
    );
    if (!this.writing) void this.writeQueued();
    return done;
  }
  private async writeQueued(): Promise<void> {
    this.writing = true;
    try {
      while (this.queued.length) {
        const changes = this.queued.splice(0);
        // Whatever goes wrong unforeseen fails every change not yet answered; an answer already given stands.
        await this.write(changes).catch((error: unknown) => {
          for (const queued of changes) queued.reject(error);
        });
      }
    } finally {
      // In the same turn as the last look at the queue, so a change queued after it starts the next write.
      this.writing = false;
    }
  }
  private async write(changes: readonly QueuedChange[]): Promise<void> {
    let state: RuntimeState;
    try {
      state = await this.read();
    } catch (error) {
      for (const queued of changes) queued.reject(error);
      return;
    }
    const applied: QueuedChange[] = [];
    for (const queued of changes) {
      // A change written with others gets a copy of its own, as a read of its own would give it, so one refused leaves
      // nothing behind; alone, a refused change writes nothing anyway.
      const draft =
        changes.length > 1
          ? (JSON.parse(JSON.stringify(state)) as RuntimeState)
          : state;
      try {
        await queued.change(draft);
        schema.parse(draft);
        state = draft;
        applied.push(queued);
      } catch (error) {
        queued.reject(error);
      }
    }
    if (!applied.length) return;
    const raw = `${JSON.stringify(state, null, 2)}\n`;
    let written: string | undefined;
    try {
      await replacePrivateFile(this.root, this.path, raw, {
        durable: true,
        // Once the new state is safely on disk, just before it replaces the current one.
        confirm: async (file) => {
          await keepPreviousGeneration(this.path, this.backupPath);
          // The renamed file keeps its inode, size and time, so this is the revision it will have as state.json.
          written = await revisionOf(file);
        },
      });
    } catch (error) {
      for (const queued of applied) queued.reject(error);
      return;
    }
    // Validated just now: the next read takes it as it was written, without reading or validating the file again.
    if (written !== undefined) this.validated = { revision: written, raw };
    for (const queued of applied) queued.resolve();
  }
  private get backupPath(): string {
    return `${this.path}.bak`;
  }
}
async function revisionOf(path: string): Promise<string | undefined> {
  const seen = await stat(path, { bigint: true }).catch(() => undefined);
  return seen && seen.mtimeNs % 1_000_000n !== 0n
    ? `${seen.ino}:${seen.size}:${seen.mtimeNs}`
    : undefined;
}
/** `value` with every object and array in it frozen, so a reader of a shared snapshot cannot change it for the others. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
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
  if (!loose(parsed) || parsed.version !== UNFIXED_NAMES_STATE_VERSION) return;
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
/** A health check's output in Activity a version before REDACTED_HEALTH_STATE_VERSION recorded, which may hold an env-file
 * value as the check printed it. Those values cannot be told apart any more, so each such health or health-restart message
 * is cut where the output began and says it is withheld. It runs before validation, on the parsed JSON, and changes nothing
 * it does not recognize. */
export function withholdUnredactedHealthOutput(parsed: unknown): void {
  if (
    !loose(parsed) ||
    typeof parsed.version !== "number" ||
    parsed.version >= REDACTED_HEALTH_STATE_VERSION ||
    !Array.isArray(parsed.activity)
  )
    return;
  for (const record of parsed.activity.filter(loose)) {
    if (
      (record.action !== "health" && record.action !== "health-restart") ||
      typeof record.message !== "string"
    )
      continue;
    // Every format a rigd recorded: "... in a row (output)", "... in a row failed (output)" and "(last output: output)".
    const output = record.message.search(
      /in a row(?: failed)? \(|\(last output: /,
    );
    if (output === -1) continue;
    const open = record.message.indexOf("(", output);
    record.message = `${record.message.slice(0, open)}(output withheld: recorded before Rig redacted health output).`;
  }
}
/** Every earlier version this rigd reads besides version 4 (see `MIGRATED_STATE_VERSIONS`) is the current one with less in
 * it, and is read as it is: version 5 has no jobs, version 6 no backups (ADR 0017), and versions before ADR 0016 record no
 * run's `source`, so the first deploy keeps no Service running, and call the checkouts job runs kept `jobCheckouts`, read
 * as `heldCheckouts`; versions before 10 record no backup's `sequence`, so their backups rank by their place in the
 * inventory. The next write saves the current version, which an older rigd refuses rather than release a
 * checkout a kept process runs in. Moving STATE_VERSION on means only adding the old number to MIGRATED_STATE_VERSIONS. */
function readEarlierVersions(parsed: unknown): void {
  if (
    !loose(parsed) ||
    typeof parsed.version !== "number" ||
    parsed.version === UNFIXED_NAMES_STATE_VERSION ||
    !MIGRATED_STATE_VERSIONS.includes(parsed.version)
  )
    return;
  parsed.version = STATE_VERSION;
  if (!Object.hasOwn(parsed, "jobCheckouts")) return;
  if (parsed.heldCheckouts === undefined)
    parsed.heldCheckouts = parsed.jobCheckouts;
  delete parsed.jobCheckouts;
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
/** The first ongoing health checks (#317, removed by ADR 0009) recorded a Service's `healthMonitor` in its plan and the
 * unhealthy stretch as a run's `healthRestarts`. The config that made them is refused now, so both are dropped as the state
 * is read: such a plan equals the plan its config made without them, and is not config drift. The next write saves it so.
 * Today's healthcheck (ADR 0012) records other fields, `healthcheck` and `healthStretch`, which this never touches. */
function forgetRetiredHealthMonitor(state: RuntimeState): void {
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
/** Point `backup` at the bytes currently published at `path`; a first write has nothing to keep. */
async function keepPreviousGeneration(
  path: string,
  backup: string,
): Promise<void> {
  if (!(await exists(path))) return;
  await rm(backup, { force: true });
  await link(path, backup);
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
