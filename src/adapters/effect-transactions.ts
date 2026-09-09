import { createEffectPreparation } from "./effect-preparation";
import { createHash } from "node:crypto";
import { copyFile, lstat, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { RigError } from "../domain/errors";
import type { Router, RouteCheckpoint } from "../providers/caddy-router";
import type { TargetEffectCheckpoint } from "../runtime/lifecycle";
import {
  artifactRevision,
  atomicFile,
  createArtifactOwnership,
} from "./artifact-ownership";
import type { ArtifactIdentity } from "./artifact-ownership";
const routeSchema = z
  .object({
    key: z.string().describe("Stable Target route identity."),
    value: z
      .string()
      .nullable()
      .describe("Opaque owned route checkpoint; null means no route."),
  })
  .strict();
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const fileSchema = z
  .object({
    path: z.string().describe("Owned installed executable or metadata path."),
    backup: z
      .string()
      .regex(/^[0-9]+\.backup$/)
      .describe("Checkpoint-local backup filename."),
    mode: z
      .number()
      .int()
      .min(0)
      .max(0o777)
      .describe("Original file permission bits."),
    before: digest.describe("Digest of original bytes, or null for absence."),
    expected: digest.describe(
      "Digest of the last bytes written by this transaction.",
    ),
  })
  .strict();
const journalSchema = z
  .object({
    targetId: z.string().describe("Stable Target effect owner."),
    phase: z
      .enum(["pending", "committed"])
      .describe("Whether rollback is still available."),
    files: z
      .array(fileSchema)
      .describe("Owned files protected by this checkpoint."),
    route: z
      .object({
        before: routeSchema.describe("Route before activation."),
        expected: routeSchema.describe("Last route written by activation."),
      })
      .describe("Route compensation state."),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
export interface ArtifactCheckpointInput extends ArtifactIdentity {
  receiptPath: string;
}
/** Durable compensations own only the snapshotted executable, ownership, receipt, and route paths. */
export function createEffectTransactions(options: {
  root: string;
  ownership: ReturnType<typeof createArtifactOwnership>;
  router: Router;
}) {
  const directory = (targetId: string) =>
    join(
      options.root,
      "effect-checkpoints",
      createHash("sha256").update(targetId).digest("hex"),
    );
  const preparation = createEffectPreparation(options.root, directory);
  const active = new Map<string, Journal>();
  const save = (journal: Journal) =>
    atomicFile(
      join(directory(journal.targetId), "journal.json"),
      JSON.stringify(journal),
    );
  const load = async (targetId: string): Promise<Journal | undefined> => {
    await preparation.validateLayout(targetId);
    try {
      const journal = journalSchema.parse(
        JSON.parse(
          await readFile(join(directory(targetId), "journal.json"), "utf8"),
        ),
      );
      if (journal.targetId !== targetId) throw new Error("Wrong Target");
      return journal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RigError(
        "EFFECTS_CHECKPOINT",
        "The Target effect checkpoint is invalid.",
        "Inspect the saved checkpoint before retrying recovery.",
      );
    }
  };
  const rollback = async (journal: Journal) => {
    await preparation.validateLayout(journal.targetId);
    if (journal.phase === "committed")
      throw new RigError(
        "EFFECTS_COMMITTED",
        "The Target effects have already been committed.",
        "Inspect current Target state before changing effects.",
      );
    for (const file of journal.files) {
      const allowed = [
        join(options.root, "bin"),
        join(options.root, "installed"),
        join(options.root, "installed", "owners"),
      ].map((path) => resolve(path));
      if (!allowed.includes(resolve(dirname(file.path))))
        throw new RigError(
          "EFFECTS_CHECKPOINT",
          "A checkpoint references an unowned path.",
          "Inspect the checkpoint before recovery.",
        );
      if (
        file.before !== null &&
        (await artifactRevision(
          join(directory(journal.targetId), file.backup),
        )) !== file.before
      )
        throw new RigError(
          "EFFECTS_CHECKPOINT",
          "A saved executable backup changed or is missing.",
          "Preserve current files and inspect the checkpoint before recovery.",
        );
    }
    for (const file of journal.files)
      if (((await artifactRevision(file.path)) ?? null) !== file.expected)
        throw new RigError(
          "EFFECTS_CHANGED",
          "An executable or ownership record changed after its checkpoint.",
          "Preserve the external change and inspect the saved checkpoint before recovery.",
          { path: file.path },
        );
    const route = await options.router.checkpoint(journal.targetId);
    if (!sameRoute(route, journal.route.expected))
      throw new RigError(
        "EFFECTS_CHANGED",
        "The route changed after its checkpoint.",
        "Inspect the current route before recovery.",
      );
    for (const file of journal.files) {
      if (file.before === null) await rm(file.path, { force: true });
      else
        await atomicFile(
          file.path,
          await readFile(join(directory(journal.targetId), file.backup)),
          file.mode,
        );
      file.expected = file.before;
      await save(journal);
    }
    await options.router.restore(journal.route.before, journal.route.expected);
    journal.route.expected = journal.route.before;
    await save(journal);
    await rm(directory(journal.targetId), { recursive: true });
    await preparation.release(journal.targetId);
    active.delete(journal.targetId);
  };
  return {
    async checkpoint(
      targetId: string,
      artifacts: readonly ArtifactCheckpointInput[],
    ): Promise<TargetEffectCheckpoint> {
      const prior = await load(targetId);
      if (prior?.phase === "committed") {
        await rm(directory(targetId), { recursive: true });
        await preparation.release(targetId);
      } else if (prior)
        throw new RigError(
          "EFFECTS_RECOVERY",
          "This Target has an unfinished effect transaction.",
          "Run down for this Target to restore its saved effects before retrying.",
        );
      const destinations = new Set<string>();
      for (const artifact of artifacts) {
        if (destinations.has(artifact.destination))
          throw new RigError(
            "ARTIFACT_CONFLICT",
            "Two Components use the same installed executable path.",
            "Give each Component a distinct installName.",
          );
        destinations.add(artifact.destination);
        await options.ownership.inspect(artifact);
      }
      const route = await options.router.checkpoint(targetId);
      await preparation.begin(targetId);
      const journal: Journal = {
        targetId,
        phase: "pending",
        files: [],
        route: { before: route, expected: route },
      };
      try {
        const paths = [
          ...new Set(
            artifacts.flatMap((artifact) => [
              artifact.destination,
              options.ownership.ownerPath(artifact.destination),
              artifact.receiptPath,
            ]),
          ),
        ];
        for (const path of paths) {
          const before = (await artifactRevision(path)) ?? null,
            backup = `${journal.files.length}.backup`,
            mode = before === null ? 0o600 : (await lstat(path)).mode & 0o777;
          if (before !== null)
            await copyFile(path, join(directory(targetId), backup));
          journal.files.push({ path, backup, mode, before, expected: before });
        }
        await save(journal);
        active.set(targetId, journal);
      } catch (error) {
        await preparation.recover(targetId);
        throw error;
      }
      return {
        targetId,
        async commit() {
          await preparation.validateLayout(targetId);
          journal.phase = "committed";
          try {
            await save(journal);
          } catch (error) {
            journal.phase = "pending";
            throw error;
          }
          active.delete(targetId);
          await rm(directory(targetId), { recursive: true, force: true })
            .then(() => preparation.release(targetId))
            .catch(() => {});
        },
        rollback: () => rollback(journal),
      };
    },
    async captureArtifact(targetId: string, paths: readonly string[]) {
      const journal = active.get(targetId);
      if (!journal) return;
      for (const path of paths) {
        const file = journal.files.find((file) => file.path === path);
        if (!file)
          throw new RigError(
            "EFFECTS_SCOPE",
            "The executable was not included in the effect checkpoint.",
            "Retry with the complete recorded Target plan.",
          );
        file.expected = (await artifactRevision(path)) ?? null;
      }
      await save(journal);
    },
    async captureRoute(targetId: string) {
      const journal = active.get(targetId);
      if (journal) {
        journal.route.expected = await options.router.checkpoint(targetId);
        await save(journal);
      }
    },
    async commit(targetId: string) {
      await preparation.validateLayout(targetId);
      const journal = active.get(targetId) ?? (await load(targetId));
      if (!journal) return preparation.recover(targetId);
      if (journal.targetId !== targetId)
        throw new RigError(
          "EFFECTS_CHECKPOINT",
          "The checkpoint belongs to a different Target.",
          "Inspect the checkpoint before retrying recovery.",
        );
      // A durable runtime commit decision authorizes roll-forward, never rollback.
      for (const file of journal.files)
        if (((await artifactRevision(file.path)) ?? null) !== file.expected)
          throw new RigError(
            "EFFECTS_CHANGED",
            "An executable changed before commit recovery.",
            "Preserve the external change and inspect the effect checkpoint.",
          );
      if (
        !sameRoute(
          await options.router.checkpoint(targetId),
          journal.route.expected,
        )
      )
        throw new RigError(
          "EFFECTS_CHANGED",
          "The route changed before commit recovery.",
          "Inspect the current route before recovery.",
        );
      journal.phase = "committed";
      await save(journal);
      active.delete(targetId);
      await rm(directory(targetId), { recursive: true, force: true })
        .then(() => preparation.release(targetId))
        .catch(() => {});
    },
    async restore(targetId: string) {
      await preparation.validateLayout(targetId);
      const journal = active.get(targetId) ?? (await load(targetId));
      if (!journal) return preparation.recover(targetId);
      if (journal.targetId !== targetId)
        throw new RigError(
          "EFFECTS_CHECKPOINT",
          "The checkpoint belongs to a different Target.",
          "Inspect the checkpoint before retrying recovery.",
        );
      if (journal.phase === "committed") {
        await rm(directory(targetId), { recursive: true, force: true });
        await preparation.release(targetId);
        active.delete(targetId);
        return;
      }
      await rollback(journal);
    },
  };
}
function sameRoute(a: RouteCheckpoint, b: RouteCheckpoint): boolean {
  return a.key === b.key && a.value === b.value;
}
