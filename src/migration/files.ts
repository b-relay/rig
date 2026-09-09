import { createHash, randomUUID } from "node:crypto";
import {
  access,
  readFile,
  readdir,
  realpath,
  stat,
  mkdir,
  open,
  writeFile,
  link,
  rm,
  rmdir,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { readProjectConfig, ConfigError } from "../config/index";
import { RigError } from "../domain/errors";
import {
  legacyStateSchema,
  legacyRegistrySchema,
  legacyRecordSchema,
  type LegacyRecord,
} from "./schema";
import { recoverSources } from "./source-evidence";
import { convertLegacyState } from "./convert";
import type {
  LegacyFile,
  MigrationPreview,
  MigrationReadOptions,
  MigrationWriteOptions,
} from "./types";
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
interface SourceFile extends LegacyFile {
  contents: Buffer;
}
async function readSource(
  root: string,
  path: string,
  required: boolean,
): Promise<SourceFile | undefined> {
  let contents: Buffer;
  try {
    contents = await readFile(path);
  } catch (error) {
    if (absent(error) && !required) return undefined;
    throw new RigError(
      "LEGACY_READ",
      "Legacy runtime evidence could not be read.",
      "Restore the missing or unreadable legacy file before migration.",
      { path },
    );
  }
  return {
    path,
    relativePath: relative(root, path),
    revision: hash(contents),
    bytes: contents.length,
    contents,
  };
}
function parseSource<T>(source: SourceFile, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(source.contents.toString("utf8")));
  } catch {
    throw new RigError(
      "LEGACY_CORRUPT",
      "Legacy state is malformed or incomplete; nothing was changed.",
      "Repair the recorded evidence or restore its exact backup before migration.",
      { path: source.path },
    );
  }
}
async function loadSources(root: string) {
  root = resolve(root);
  const stateFile = (await readSource(
      root,
      join(root, "runtime", "rigd-state.json"),
      true,
    ))!,
    registryFile = await readSource(root, join(root, "registry.json"), false);
  const legacy = parseSource(stateFile, legacyStateSchema),
    registry = registryFile
      ? parseSource(registryFile, legacyRegistrySchema)
      : {};
  const files: SourceFile[] = [
      stateFile,
      ...(registryFile ? [registryFile] : []),
    ],
    inventories: LegacyRecord[] = [];
  for (const entry of await readdir(join(root, "runtime"), {
    withFileTypes: true,
  }))
    if (entry.isDirectory()) {
      const source = await readSource(
        root,
        join(root, "runtime", entry.name, "deployments.json"),
        false,
      );
      if (source) {
        files.push(source);
        inventories.push(...parseSource(source, z.array(legacyRecordSchema)));
      }
    }
  return { files, legacy, registry, inventories };
}
function sourceRevision(files: readonly LegacyFile[]): string {
  return hash(
    [...files]
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((file) => `${file.relativePath}\0${file.revision}`)
      .join("\n"),
  );
}
/** Read-only legacy inspection. The result exposes conversion blockers and adoption work separately.
 * No source, token, config, process, route, or runtime inventory is changed.
 */
export async function readLegacyState(
  root: string,
  options: MigrationReadOptions = {},
): Promise<MigrationPreview> {
  return buildPreview(await loadSources(root), options);
}
async function assertAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (absent(error)) return;
    throw error;
  }
  throw new RigError(
    "MIGRATION_EXISTS",
    "New runtime state already exists.",
    "Migration never replaces existing new runtime state.",
    { path },
  );
}
/** Explicit one-time migration of metadata only. Requires complete recorded policy, snapshots exact
 * source bytes, retains original history, and atomically publishes only into an absent new state file.
 * The adoption manifest remains pending; migration itself never establishes provider ownership.
 */
export async function migrateLegacyState(
  root: string,
  options: MigrationWriteOptions,
): Promise<{
  statePath: string;
  backupPath: string;
  adoptionPath: string;
  preview: MigrationPreview;
}> {
  if (!options || !/^[a-f0-9]{64}$/.test(options.expectedRevision))
    throw new RigError(
      "MIGRATION_REVISION",
      "An explicit migration preview revision is required.",
      "Read and review a migration preview before publication.",
    );
  root = resolve(root);
  const runtime = join(root, "runtime"),
    statePath = join(runtime, "state.json"),
    lockPath = join(runtime, "migration.lock"),
    oldLock = join(runtime, "rigd-state.lock");
  await assertAbsent(statePath);
  await mkdir(runtime, { recursive: true });
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new RigError(
      "MIGRATION_LOCKED",
      "Another migration may be running.",
      "Inspect the migration lock before retrying.",
    );
  }
  let oldLocked = false,
    temporary: string | undefined,
    adoptionPath: string | undefined,
    published = false;
  try {
    try {
      await mkdir(oldLock);
      oldLocked = true;
    } catch {
      throw new RigError(
        "LEGACY_BUSY",
        "Legacy runtime state is being changed.",
        "Stop legacy writers and retry migration.",
      );
    }
    await assertAbsent(statePath);
    const loaded = await loadSources(root),
      preview = await buildPreview(loaded, options);
    if (preview.revision !== options.expectedRevision)
      throw new RigError(
        "MIGRATION_CHANGED",
        "Legacy evidence changed since the reviewed preview.",
        "Read a fresh preview before publication.",
      );
    if (!preview.state || preview.issues.length)
      throw new RigError(
        "MIGRATION_BLOCKED",
        "Legacy state requires reconciliation before migration.",
        "Inspect the read-only migration preview; do not infer missing deployment policy from current config.",
        { issues: preview.issues },
      );
    const backupPath = join(
      root,
      "backups",
      `typescript-migration-${preview.revision}`,
    );
    await mkdir(backupPath, { recursive: true, mode: 0o700 });
    for (const source of loaded.files) {
      const destination = join(backupPath, source.relativePath);
      await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
      try {
        await writeFile(destination, source.contents, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
        if (hash(await readFile(destination)) !== source.revision)
          throw new RigError(
            "MIGRATION_BACKUP",
            "An existing migration backup has different contents.",
            "Preserve both versions and resolve the backup conflict.",
            { path: destination },
          );
      }
    }
    const manifest = {
      version: 1,
      status: "requires-adoption",
      sourceRevision: preview.revision,
      backupPath,
      adoption: preview.adoption,
      recoveredSources: preview.recoveredSources,
      warnings: preview.warnings,
      history: preview.history,
    };
    const backupManifest = join(backupPath, "manifest.json");
    await writeFile(backupManifest, JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
    });
    const current = await loadSources(root);
    if (sourceRevision(current.files) !== preview.revision)
      throw new RigError(
        "MIGRATION_CHANGED",
        "Legacy evidence changed during migration.",
        "Read a fresh preview and retry.",
      );
    const pendingPath = join(runtime, "legacy-adoption.json");
    await writeFile(pendingPath, JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    adoptionPath = pendingPath;
    temporary = join(runtime, `migration-${randomUUID()}.tmp`);
    const pending = await open(temporary, "wx", 0o600);
    try {
      await pending.writeFile(JSON.stringify(preview.state, null, 2) + "\n");
      await pending.sync();
    } finally {
      await pending.close();
    }
    await link(temporary, statePath);
    published = true;
    return { statePath, backupPath, adoptionPath, preview };
  } finally {
    if (temporary) await rm(temporary, { force: true });
    if (adoptionPath && !published) await rm(adoptionPath, { force: true });
    if (oldLocked) await rmdir(oldLock);
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/** Current registration evidence is checked independently of recorded deployment policy. */
async function buildPreview(
  loaded: Awaited<ReturnType<typeof loadSources>>,
  options: MigrationReadOptions,
): Promise<MigrationPreview> {
  const recovery = recoverSources(loaded, options.recoveredSources ?? []);
  const preview: MigrationPreview = {
    ...convertLegacyState({
      ...loaded,
      legacy: recovery.legacy,
      inventories: recovery.inventories,
    }),
    recoveredSources: recovery.recoveredSources,
    revision: sourceRevision(loaded.files),
    files: loaded.files.map(({ contents, ...file }) => file),
  };
  preview.issues.push(...recovery.issues);
  const knownPaths = new Set<string>();
  for (const project of preview.projects) {
    let repository: string;
    try {
      repository = await realpath(project.repoPath);
      if (!(await stat(repository)).isDirectory())
        throw new Error("not a directory");
    } catch {
      preview.warnings.push({
        code: "missing_repository",
        message: "The registered repository is missing or unreadable.",
        project: project.name,
      });
      continue;
    }
    if (knownPaths.has(repository))
      preview.issues.push({
        code: "shared_repository_identity",
        message: "Multiple Project names refer to the same current repository.",
        project: project.name,
      });
    knownPaths.add(repository);
    try {
      const document = await readProjectConfig(repository);
      if (document.config.name !== project.name) {
        preview.issues.push({
          code: "current_identity_mismatch",
          message: "The current config identity differs from its registration.",
          project: project.name,
        });
        continue;
      }
      project.repoPath = repository;
      project.configPath = document.path;
      const record = preview.state?.projects.find(
        (record) => record.name === project.name,
      );
      if (record) {
        record.repoPath = repository;
        record.configPath = document.path;
      }
    } catch (error) {
      const ambiguous =
        error instanceof ConfigError && error.code === "ambiguous_config";
      (ambiguous ? preview.issues : preview.warnings).push({
        code: ambiguous ? "ambiguous_current_config" : "invalid_current_config",
        message:
          "The registered repository has missing, ambiguous, or invalid current configuration.",
        project: project.name,
      });
    }
  }
  if (preview.issues.length) delete preview.state;
  return preview;
}
