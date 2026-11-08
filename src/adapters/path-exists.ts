import { stat } from "node:fs/promises";

/** Whether anything is at `path`, links followed; a failure other than absence is thrown. */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
