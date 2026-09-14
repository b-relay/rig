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
import { STATE_VERSION, runtimeStateSchema as schema } from "./state-schema";
import { backfillSourceRoots } from "./state-compat";
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
        for (const path of [
          join(this.root, "runtime", "rigd-state.json"),
          join(this.root, "registry.json"),
        ]) {
          try {
            await access(path);
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw probe;
          }
          throw new RigError(
            "LEGACY_STATE_PRESENT",
            "This Rig root contains legacy runtime state.",
            "Complete the explicit backed-up compatibility cutover before starting the new runtime.",
          );
        }
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
    return backfillSourceRoots({ ...state, version: STATE_VERSION }, this.root);
  }
  /** A file from a newer rigd is refused by version before its shape is judged. */
  private assertSupportedVersion(parsed: unknown): void {
    const version =
      typeof parsed === "object" && parsed !== null && "version" in parsed
        ? parsed.version
        : undefined;
    if (typeof version === "number" && version > STATE_VERSION)
      throw new RigError(
        "STATE_VERSION",
        "Runtime state was written by a newer rigd; nothing was changed.",
        `Runtime state at ${this.path} is version ${version}, but this rigd reads version ${STATE_VERSION}. Upgrade rigd, or restore the state that version wrote, before retrying.`,
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
