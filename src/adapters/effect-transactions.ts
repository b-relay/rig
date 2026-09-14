import { createEffectPreparation } from "./effect-preparation";
import { createHash } from "node:crypto";
import { copyFile, lstat, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  RigError,
  describeInvalidDocument,
  failureReason,
} from "../domain/errors";
import type { Router, RouteCheckpoint } from "../providers/caddy-router";
import type {
  PrunedCheckpoint,
  TargetEffectCheckpoint,
} from "../runtime/lifecycle";
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
  .strip();
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
  .loose();
/** Bump only when a field changes meaning or a new field must be understood to act
 * safely. Adding a field older rigds may ignore is not a bump: they keep unknown keys. */
export const JOURNAL_VERSION = 1;
const journalSchema = z
  .object({
    version: z
      .literal(JOURNAL_VERSION)
      .optional()
      .describe(
        "Journal format version; absent in journals written before it existed.",
      ),
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
      .loose()
      .describe("Route compensation state."),
  })
  .loose();
type Journal = z.infer<typeof journalSchema>;
const versionSchema = z.object({ version: z.number().optional() }).loose();
const CHECKPOINTS = "effect-checkpoints";
/** A pending journal whose recorded state still equals its captured state has nothing to undo. */
function recordedChange(journal: Journal): boolean {
  return (
    journal.files.some(
      (file) => file.applying || file.expected !== file.before,
    ) ||
    journal.route.applying === true ||
    !sameRoute(journal.route.before, journal.route.expected)
  );
}
export interface ArtifactCheckpointInput extends ArtifactIdentity {
  receiptPath: string;
}
/** Durable compensations own only the snapshotted executable, ownership, receipt, and route paths. */
export function createEffectTransactions(options: {
  root: string;
  ownership: ReturnType<typeof createArtifactOwnership>;
  router: Router;
}) {
  const hash = (targetId: string) =>
    createHash("sha256").update(targetId).digest("hex");
  const directory = (targetId: string) =>
    join(options.root, CHECKPOINTS, hash(targetId));
  const preparation = createEffectPreparation(options.root, directory);
  const active = new Map<string, Journal>();
  const save = (journal: Journal) =>
    atomicFile(
      join(directory(journal.targetId), "journal.json"),
      JSON.stringify({ ...journal, version: JOURNAL_VERSION }),
    );
  /** The saved journal, or undefined when none exists. Refuses a journal from a
   * newer rigd or one with an invalid value, naming the file and the problem. */
  const readJournal = async (path: string): Promise<Journal | undefined> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
      const { version } = versionSchema.parse(parsed);
      if (version !== undefined && version > JOURNAL_VERSION)
        throw new RigError(
          "EFFECTS_CHECKPOINT",
          "The Target effect checkpoint was written by a newer rigd; nothing was changed.",
          `The effect checkpoint at ${path} is version ${version}, but this rigd reads version ${JOURNAL_VERSION}. Upgrade rigd, or restore the checkpoint that version wrote, before retrying.`,
          { path, version, supported: JOURNAL_VERSION },
        );
      return journalSchema.parse(parsed);
    } catch (error) {
      if (error instanceof RigError) throw error;
      throw new RigError(
        "EFFECTS_CHECKPOINT",
        "The Target effect checkpoint is invalid; nothing was changed.",
        `The effect checkpoint at ${path} ${describeInvalidDocument(error, "effect checkpoint")}. Inspect it before retrying recovery.`,
        {
          path,
          ...(error instanceof z.ZodError
            ? { issues: error.issues.slice(0, 3) }
            : {}),
        },
      );
    }
  };
  const load = async (targetId: string): Promise<Journal | undefined> => {
    await preparation.validateLayout(targetId);
    const path = join(directory(targetId), "journal.json");
    const journal = await readJournal(path);
    if (journal && journal.targetId !== targetId)
      throw new RigError(
        "EFFECTS_CHECKPOINT",
        "The checkpoint belongs to a different Target.",
        `The effect checkpoint at ${path} names Target ${journal.targetId}. Inspect it before retrying recovery.`,
        { path, targetId: journal.targetId },
      );
    return journal;
  };
  /** What one entry under effect-checkpoints/ is: a checkpoint directory, a
   * preparation claim, or evidence preserved for inspection (never pruned). */
  const classify = (name: string) => {
    const match = /^([a-f0-9]{64})(\.preparing\.json)?$/.exec(name);
    if (!match) return undefined;
    return { hash: match[1]!, kind: match[2] ? "claim" : "directory" } as const;
  };
  const claimedTarget = async (path: string): Promise<string | undefined> => {
    try {
      const claim = z
        .object({ targetId: z.string() })
        .loose()
        .parse(JSON.parse(await readFile(path, "utf8")));
      return claim.targetId;
    } catch {
      return undefined;
    }
  };
  const pruneCheckpoints = async (
    live: ReadonlySet<string>,
  ): Promise<PrunedCheckpoint[]> => {
    const root = join(options.root, CHECKPOINTS);
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const retained = new Set([...live].map(hash));
    const orphans = new Map<string, { directory?: string; claim?: string }>();
    for (const name of names) {
      const entry = classify(name);
      if (!entry || retained.has(entry.hash)) continue;
      const found = orphans.get(entry.hash) ?? {};
      found[entry.kind] = join(root, name);
      orphans.set(entry.hash, found);
    }
    const pruned: PrunedCheckpoint[] = [];
    for (const { directory, claim } of orphans.values()) {
      // A claim beside its directory leaves with it; alone, it is the whole orphan.
      if (!directory) {
        const targetId = await claimedTarget(claim!);
        await rm(claim!, { force: true });
        pruned.push({
          path: claim!,
          ...(targetId ? { targetId } : {}),
          outcome: "removed",
        });
        continue;
      }
      const read = await readJournal(join(directory, "journal.json")).then(
        (journal) => ({ journal }),
        (error: unknown) => ({ journal: undefined, error }),
      );
      const journal = read.journal;
      const targetId = journal ? { targetId: journal.targetId } : {};
      // Unreadable evidence and undone changes are kept; only what nothing depends on leaves.
      const reason =
        "error" in read
          ? `its journal could not be read: ${failureReason(read.error)}`
          : journal?.phase === "pending" && recordedChange(journal)
            ? "its pending journal recorded a change that only rollback can undo"
            : undefined;
      if (reason) {
        pruned.push({
          path: directory,
          ...targetId,
          outcome: "retained",
          reason,
        });
        continue;
      }
      await rm(directory, { recursive: true, force: true });
      if (claim) await rm(claim, { force: true });
      pruned.push({ path: directory, ...targetId, outcome: "removed" });
    }
    return pruned;
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
    pruneCheckpoints,
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
        version: JOURNAL_VERSION,
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
