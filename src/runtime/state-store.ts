import {
  access,
  mkdir,
  readFile,
  rename,
  writeFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { runtimeStateSchema as schema } from "./state-schema";
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
      return schema.parse(JSON.parse(raw));
    } catch {
      throw new RigError(
        "STATE_CORRUPT",
        "Invalid runtime state; nothing was changed.",
        "Restore a known-good state backup before retrying.",
        { path: this.path },
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
