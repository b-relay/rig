import {
  access,
  mkdir,
  readFile,
  rename,
  writeFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runtimeStateSchema as schema } from "./state-schema";
import { backfillSourceRoots } from "./state-compat";
import { RigError } from "../domain/errors";
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
        return { version: 2, projects: [], targets: [], activity: [] };
      }
      throw new RigError(
        "STATE_READ",
        "Unable to read runtime state.",
        "Check state directory permissions.",
      );
    }
    try {
      return backfillSourceRoots(schema.parse(JSON.parse(raw)), this.root);
    } catch (error) {
      throw new RigError(
        "STATE_CORRUPT",
        "Invalid runtime state; nothing was changed.",
        `Runtime state at ${this.path} ${describeCorruption(error)}. Restore a known-good copy of the file, or repair it by hand, before retrying.`,
        {
          path: this.path,
          ...(error instanceof z.ZodError
            ? { issues: error.issues.slice(0, 3) }
            : {}),
        },
      );
    }
  }

  update(change: (state: RuntimeState) => void | Promise<void>): Promise<void> {
    const operation = this.queue.then(async () => {
      const state = await this.read();
      await change(state);
      schema.parse(state);
      await mkdir(join(this.root, "runtime"), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.next`;
      try {
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
          mode: 0o600,
        });
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
/** The first thing wrong with a state file, worded so the user can open it and look. */
function describeCorruption(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (!issue) return "does not match the runtime state schema";
    const location = issue.path.length
      ? issue.path.map(String).join(".")
      : "the top level";
    return `has an invalid value at ${location}: ${issue.message}`;
  }
  return `is not valid JSON${error instanceof Error ? ` (${error.message})` : ""}`;
}
