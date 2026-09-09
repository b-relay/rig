import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { RigError } from "../domain/errors";
import { atomicFile } from "./artifact-ownership";
const claimSchema = z
  .object({
    version: z.literal(1).describe("Preparation ownership format version."),
    targetId: z.string().describe("Target that reserved this preparation."),
    directory: z
      .string()
      .describe("Canonical checkpoint directory reserved before copying."),
  })
  .strict();
function invalid() {
  return new RigError(
    "EFFECTS_CHECKPOINT",
    "The Target checkpoint preparation is ambiguous.",
    "Preserve the saved evidence and inspect it before retrying recovery.",
  );
}
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** Filesystem effect owner. One daemon serializes operations per Target. */
export function createEffectPreparation(
  root: string,
  directory: (targetId: string) => string,
) {
  const claimPath = (targetId: string) =>
    directory(targetId) + ".preparing.json";
  const canonicalDirectory = async (targetId: string) =>
    join(
      await realpath(root),
      "effect-checkpoints",
      basename(directory(targetId)),
    );
  const validateLayout = async (targetId: string) => {
    for (const path of [dirname(directory(targetId)), directory(targetId)]) {
      const info = await stat(path);
      if (info && !info.isDirectory()) throw invalid();
    }
    const journal = await stat(join(directory(targetId), "journal.json"));
    if (journal && !journal.isFile()) throw invalid();
    await claim(targetId);
    if (journal) {
      for (const name of await readdir(directory(targetId))) {
        if (
          !(
            name === "journal.json" ||
            /^[0-9]+\.backup$/.test(name) ||
            /^journal\.json\.[a-f0-9-]{36}\.tmp$/.test(name)
          ) ||
          !(await lstat(join(directory(targetId), name))).isFile()
        )
          throw invalid();
      }
    }
  };
  const claim = async (targetId: string) => {
    const info = await stat(claimPath(targetId));
    if (!info) return undefined;
    if (!info.isFile()) throw invalid();
    try {
      const saved = claimSchema.parse(
        JSON.parse(await readFile(claimPath(targetId), "utf8")),
      );
      if (
        saved.targetId !== targetId ||
        saved.directory !== (await canonicalDirectory(targetId))
      )
        throw invalid();
      return saved;
    } catch {
      throw invalid();
    }
  };
  return {
    validateLayout,
    async begin(targetId: string) {
      await validateLayout(targetId);
      if (
        (await stat(directory(targetId))) ||
        (await stat(claimPath(targetId)))
      )
        throw new RigError(
          "EFFECTS_RECOVERY",
          "A saved Target effect preparation already exists.",
          "Run down for this Target to recover its preparation before retrying.",
        );
      await mkdir(dirname(directory(targetId)), {
        recursive: true,
        mode: 0o700,
      });
      await atomicFile(
        claimPath(targetId),
        JSON.stringify({
          version: 1,
          targetId,
          directory: await canonicalDirectory(targetId),
        }),
      );
      await mkdir(directory(targetId), { mode: 0o700 });
    },
    async recover(targetId: string) {
      await validateLayout(targetId);
      if (await stat(join(directory(targetId), "journal.json")))
        throw invalid();
      const owned = await claim(targetId);
      const exists = await stat(directory(targetId));
      if (!exists) {
        if (owned) await rm(claimPath(targetId));
        return;
      }
      const names = await readdir(directory(targetId));
      for (const name of names) {
        const known =
          /^[0-9]+\.backup$/.test(name) ||
          (owned && /^journal\.json\.[a-f0-9-]{36}\.tmp$/.test(name));
        if (!known || !(await lstat(join(directory(targetId), name))).isFile())
          throw invalid();
      }
      if (!owned) {
        const archivePath = directory(targetId) + ".preserved-" + randomUUID();
        await rename(directory(targetId), archivePath);
        throw new RigError(
          "EFFECTS_PREPARATION_PRESERVED",
          "The interrupted checkpoint preparation was preserved for inspection.",
          `Evidence is retained at ${archivePath}. Retry the Target operation.`,
          { archivePath, targetId },
        );
      }
      for (const name of names) await rm(join(directory(targetId), name));
      await rmdir(directory(targetId));
      await rm(claimPath(targetId));
    },
    async release(targetId: string) {
      // A journal is authoritative until its directory has been removed.
      if (await claim(targetId)) await rm(claimPath(targetId));
    },
  };
}
