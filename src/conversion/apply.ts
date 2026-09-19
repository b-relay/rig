import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { RigError } from "../domain/errors";
import {
  readConversion,
  type ConversionDeps,
  type ConversionPreview,
} from "./inventory";
import { reviewSchema, type Review } from "./review";

const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const STATE = "runtime/state.json",
  PENDING = "runtime/conversion-pending.json";
const backupManifestSchema = z.looseObject({
  version: z.literal(1),
  kind: z.literal("config-cutover"),
  revision: z.string(),
  files: z.array(
    z.object({
      relativePath: z.string(),
      sha256: z.string(),
      size: z.number(),
    }),
  ),
});
export interface ConversionResult {
  /** `unchanged`: the root was already converted, or holds nothing to convert. */
  status: "converted" | "unchanged";
  revision: string;
  backupPath?: string;
  reportPath?: string;
}

/** Read-only: what a conversion under `review` would do, and what blocks it. A conversion an earlier apply left unfinished
 * is named in `interrupted`. */
export async function previewConversion(
  root: string,
  review: Review,
  deps: ConversionDeps,
): Promise<ConversionPreview & { interrupted?: unknown }> {
  const { preview } = await readConversion(root, review, deps),
    pending = await readOptional(join(resolve(root), PENDING));
  return pending === undefined
    ? preview
    : { ...preview, interrupted: JSON.parse(pending.toString("utf8")) };
}

/** Converts the metadata of a stopped root, once, for exactly the reviewed revision. Order is the safety argument: exact
 * backup, then the report and candidates, and the state file last, atomically; it is the only existing file that changes.
 * The new runtime refuses the root until that publication, so an interruption anywhere earlier leaves a root that is still
 * unconverted, with `runtime/conversion-pending.json` naming the backup. Data, logs, sources and repositories are never
 * written. */
export async function applyConversion(
  root: string,
  options: { review: Review; expectedRevision: string },
  deps: ConversionDeps,
): Promise<ConversionResult> {
  if (!/^[a-f0-9]{64}$/.test(options.expectedRevision))
    throw new RigError(
      "CONVERSION_REVISION",
      "A reviewed preview revision is required.",
      "Run the cutover preview, review it, and pass its revision.",
    );
  root = resolve(root);
  const first = await readConversion(root, options.review, deps);
  if (first.preview.status !== "legacy") {
    // Only the marker of a conversion whose state was already published can be left here.
    if (first.preview.status === "converted")
      await rm(join(root, PENDING), { force: true });
    return { status: "unchanged", revision: first.preview.revision };
  }
  const lockPath = join(root, "runtime", "conversion.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new RigError(
      "CONVERSION_LOCKED",
      "Another conversion may be running on this root.",
      `If none is, remove ${lockPath} and retry.`,
      { path: lockPath },
    );
  }
  let temporary: string | undefined;
  try {
    const work = await readConversion(root, options.review, deps),
      preview = work.preview;
    assertReviewed(preview, options.expectedRevision);
    if (preview.blockers.length || work.state === undefined)
      throw new RigError(
        "CONVERSION_BLOCKED",
        `The conversion is blocked: ${preview.blockers.map((blocker) => `${blocker.code}${blocker.subject ? ` (${blocker.subject})` : ""}`).join(", ")}.`,
        "Resolve every blocker the preview lists, then preview again. Nothing was changed.",
        { blockers: preview.blockers },
      );
    const backupPath = join(
        root,
        "backups",
        `config-cutover-${preview.revision}`,
      ),
      reportPath = join(root, "conversion", preview.revision),
      changes = [{ relativePath: STATE, action: "replace" }];
    for (const file of work.files)
      await writeExact(join(backupPath, file.relativePath), file.contents);
    await writeFile(
      join(backupPath, "manifest.json"),
      json({
        version: 1,
        kind: "config-cutover",
        revision: preview.revision,
        createdAt: deps.now(),
        root,
        files: preview.evidence.files,
        changes,
        notCopied:
          "Data directories, logs, checked-out Commits, published Tools and repositories are not copied and not changed.",
        dataPaths: preview.evidence.dataPaths,
      }),
      { mode: 0o600 },
    );
    deps.checkpoint?.("backup");
    await mkdir(reportPath, { recursive: true, mode: 0o700 });
    for (const project of preview.projects)
      if (project.candidate)
        await writeFile(
          join(reportPath, `${project.name}.rig.yaml`),
          project.candidate.yaml,
          { mode: 0o600 },
        );
    await writeFile(
      join(reportPath, "manifest.json"),
      json({ version: 1, appliedAt: deps.now(), backupPath, ...preview }),
      { mode: 0o600 },
    );
    // The evidence is read a third time: whatever changed it since the lock was taken is not what was reviewed.
    assertReviewed(
      (await readConversion(root, options.review, deps)).preview,
      options.expectedRevision,
    );
    await writeFile(
      join(root, PENDING),
      json({ revision: preview.revision, backupPath, startedAt: deps.now() }),
      { mode: 0o600 },
    );
    deps.checkpoint?.("publish");
    temporary = join(root, "runtime", `conversion-${randomUUID()}.tmp`);
    const pending = await open(temporary, "wx", 0o600);
    try {
      await pending.writeFile(json(work.state));
      await pending.sync();
    } finally {
      await pending.close();
    }
    await rename(temporary, join(root, STATE));
    temporary = undefined;
    await rm(join(root, PENDING), { force: true });
    return {
      status: "converted",
      revision: preview.revision,
      backupPath,
      reportPath,
    };
  } finally {
    if (temporary) await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/** Puts back exactly what `applyConversion` changed, from its backup, after verifying every byte against the backup
 * manifest. Refuses while a daemon or a supervised process is alive on the root. Whatever the new runtime wrote since
 * (logs, new Deployments, data) stays where it is; nothing but the listed metadata is touched. */
export async function rollbackConversion(
  root: string,
  backupPath: string,
  deps: ConversionDeps,
): Promise<{ restored: string[] }> {
  root = resolve(root);
  backupPath = resolve(backupPath);
  const raw = await readOptional(join(backupPath, "manifest.json"));
  let manifest;
  try {
    manifest = backupManifestSchema.parse(
      JSON.parse((raw ?? Buffer.from("")).toString("utf8")),
    );
  } catch {
    throw new RigError(
      "CONVERSION_BACKUP",
      `${backupPath} is not a configuration cutover backup.`,
      "Pass the backupPath that the cutover apply printed.",
      { backupPath },
    );
  }
  const live = (
    await readConversion(root, reviewSchema.parse({}), deps)
  ).preview.blockers.filter((blocker) =>
    ["daemon_running", "live_process"].includes(blocker.code),
  );
  if (live.length)
    throw new RigError(
      "CONVERSION_BLOCKED",
      `The rollback is blocked: ${live.map((blocker) => blocker.message).join(" ")}`,
      "Stop every Target and the daemon (rig down, rigd uninstall), then roll back. Nothing was changed.",
      { blockers: live },
    );
  // Only the state file is ever restored, whatever a manifest claims: a backup directory is input, not authority.
  const recorded = manifest.files.find((file) => file.relativePath === STATE),
    contents = await readOptional(join(backupPath, STATE));
  if (!recorded || !contents || digest(contents) !== recorded.sha256)
    throw new RigError(
      "CONVERSION_BACKUP",
      `The backup of ${STATE} is missing or does not match its manifest.`,
      "Nothing was changed. Restore the backup directory itself before rolling back.",
      { backupPath, relativePath: STATE },
    );
  const path = join(root, STATE),
    temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  await rm(join(root, PENDING), { force: true });
  return { restored: [STATE] };
}

function assertReviewed(preview: ConversionPreview, expected: string): void {
  if (preview.revision !== expected)
    throw new RigError(
      "CONVERSION_CHANGED",
      "The root, a Project configuration or the review changed since the reviewed preview.",
      "Run the cutover preview again and review the new revision. Nothing was changed.",
      { expected, actual: preview.revision },
    );
}
async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** A backup file is written once; an existing one must already hold the same bytes. */
async function writeExact(path: string, contents: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (digest(await readFile(path)) !== digest(contents))
      throw new RigError(
        "CONVERSION_BACKUP",
        "An existing backup of this revision has different contents.",
        "Keep both and move the existing backup directory aside before retrying.",
        { path },
      );
  }
}
