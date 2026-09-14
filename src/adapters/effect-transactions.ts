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
    applying: z
      .boolean()
      .optional()
      .describe(
        "A write was begun but not captured; current bytes may be this transaction's own unrecorded work.",
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
        applying: z
          .boolean()
          .optional()
          .describe(
            "A route change was begun but not captured; the current route may be this transaction's own unrecorded work.",
          ),
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
  const removeCheckpoint = async (
    targetId: string,
    options: { allowMissingDirectory: boolean },
  ): Promise<void> => {
    await rm(directory(targetId), {
      recursive: true,
      force: options.allowMissingDirectory,
    });
    await preparation.release(targetId);
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
    // A write this transaction began but never captured is its own work:
    // whatever is there now was put there by the interrupted daemon.
    for (const file of journal.files)
      if (
        !file.applying &&
        ((await artifactRevision(file.path)) ?? null) !== file.expected
      )
        throw new RigError(
          "EFFECTS_CHANGED",
          "An executable or ownership record changed after its checkpoint.",
          "Preserve the external change and inspect the saved checkpoint before recovery.",
          { path: file.path },
        );
    const route = await options.router.checkpoint(journal.targetId);
    if (journal.route.applying) journal.route.expected = route;
    else if (!sameRoute(route, journal.route.expected))
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
      delete file.applying;
      await save(journal);
    }
    await options.router.restore(journal.route.before, journal.route.expected);
    journal.route.expected = journal.route.before;
    delete journal.route.applying;
    await save(journal);
    await removeCheckpoint(journal.targetId, { allowMissingDirectory: false });
    active.delete(journal.targetId);
  };
  return {
    async checkpoint(
      targetId: string,
      artifacts: readonly ArtifactCheckpointInput[],
    ): Promise<TargetEffectCheckpoint> {
      const prior = await load(targetId);
      if (prior?.phase === "committed") {
        await removeCheckpoint(targetId, { allowMissingDirectory: false });
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
          await removeCheckpoint(targetId, {
            allowMissingDirectory: true,
          }).catch(() => {});
        },
        rollback: () => rollback(journal),
      };
    },
    /** Run a change to owned files. The journal records the intent before the
     * change and the resulting bytes after it, so a crash in between is
     * recognised as this transaction's own work. Without an active checkpoint
     * the change simply runs. Rejects EFFECTS_SCOPE before changing anything
     * when a path was not checkpointed. */
    async withArtifactChange(
      targetId: string,
      paths: readonly string[],
      change: () => Promise<void>,
    ): Promise<void> {
      const journal = active.get(targetId);
      if (!journal) return change();
      const files = paths.map((path) => {
        const file = journal.files.find((file) => file.path === path);
        if (!file)
          throw new RigError(
            "EFFECTS_SCOPE",
            "The executable was not included in the effect checkpoint.",
            "Retry with the complete recorded Target plan.",
          );
        return file;
      });
      for (const file of files) file.applying = true;
      await save(journal);
      try {
        await change();
      } finally {
        for (const file of files) {
          file.expected = (await artifactRevision(file.path)) ?? null;
          delete file.applying;
        }
        await save(journal);
      }
    },
    /** Run a change to the owned route with the same intent-then-capture record. */
    async withRouteChange(
      targetId: string,
      change: () => Promise<void>,
    ): Promise<void> {
      const journal = active.get(targetId);
      if (!journal) return change();
      journal.route.applying = true;
      await save(journal);
      try {
        await change();
      } finally {
        journal.route.expected = await options.router.checkpoint(targetId);
        delete journal.route.applying;
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
      // Writes begun but never captured are this transaction's own work.
      for (const file of journal.files)
        if (
          !file.applying &&
          ((await artifactRevision(file.path)) ?? null) !== file.expected
        )
          throw new RigError(
            "EFFECTS_CHANGED",
            "An executable changed before commit recovery.",
            "Preserve the external change and inspect the effect checkpoint.",
          );
      if (
        !journal.route.applying &&
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
      await removeCheckpoint(targetId, { allowMissingDirectory: true }).catch(
        () => {},
      );
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
        await removeCheckpoint(targetId, { allowMissingDirectory: true });
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
