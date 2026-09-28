import { createHash, randomUUID } from "node:crypto";
import {
  access,
  readFile,
  writeFile,
  rename,
  unlink,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  isAlias,
  isMap,
  isScalar,
  parseAllDocuments,
  stringify,
  visit,
} from "yaml";
import { acquireProcessLock, type LockHeld } from "../adapters/process-lock";
import { ConfigError } from "./errors";
import { PROJECT_SCHEMA_COMMENT } from "./json-schema";
import { applyYamlEdits, type ConfigEdit } from "./editor";
import { recipeMarkers, type RecipeMarker } from "./recipe-markers";
export type { ConfigEdit } from "./editor";
import {
  DEFAULT_TARGET_NAMES,
  parseHostConfig,
  declaredFormat,
  parseProjectConfig,
  parseProjectDocument,
} from "./schema";
import { LATEST_FORMAT, type ConfigFormat } from "./formats";
import { upgradeYamlText } from "./upgrade";
import { unifiedDiff } from "./text-diff";
import { isDeepStrictEqual } from "node:util";
import type { ConfigDocument, HostConfig, ProjectConfig } from "./types";
/** Validates a decoded document; a Project document also names the format it is written in. */
type Validate<T> = (value: unknown) => { config: T; format?: ConfigFormat };
const hostDocument: Validate<HostConfig> = (value) => ({
  config: parseHostConfig(value),
});
const revisionOf = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
/** Filesystem effect owner: finds the YAML document; permission failures are preserved. */
async function locateConfig(
  directory: string,
  stem: string,
): Promise<string | undefined> {
  const path = join(directory, `${stem}.yaml`);
  try {
    await access(path);
    return path;
  } catch (error) {
    if (missing(error)) return undefined;
    throw new ConfigError("Unable to inspect config document.", "read_failed", {
      path,
    });
  }
}
/** Pure YAML 1.2 parser. Restrictions run on the syntax tree before domain validation. */
function yamlDocument(raw: string, path: string) {
  const documents = parseAllDocuments(raw, {
    version: "1.2",
    uniqueKeys: true,
    strict: true,
  });
  if (documents.length !== 1)
    throw new ConfigError(
      "Config must contain exactly one YAML document.",
      "invalid_yaml",
      { path },
    );
  const document = documents[0]!;
  if (document.directives?.yaml.version !== "1.2")
    throw new ConfigError("Config must use YAML 1.2.", "invalid_yaml", {
      path,
    });
  if (document.errors.length || document.warnings.length)
    throw new ConfigError(
      "Invalid or unsupported YAML syntax.",
      "invalid_yaml",
      { path },
    );
  visit(document, (_key, node) => {
    if (
      isAlias(node) ||
      (typeof node === "object" &&
        node !== null &&
        (("anchor" in node && node.anchor) || ("tag" in node && node.tag)))
    )
      throw new ConfigError(
        "YAML anchors, aliases, and explicit tags are unsupported.",
        "invalid_yaml",
        { path },
      );
    if (isMap(node))
      for (const item of node.items)
        if (isScalar(item.key) && item.key.value === "<<")
          throw new ConfigError(
            "YAML merge keys are unsupported.",
            "invalid_yaml",
            { path },
          );
  });
  return document;
}
function decodeDocument<T>(
  raw: string,
  path: string,
  validate: Validate<T>,
): ConfigDocument<T> {
  let value: unknown;
  let markers: RecipeMarker[];
  try {
    const document = yamlDocument(raw, path);
    value = document.toJS({ maxAliasCount: 0 });
    markers = recipeMarkers(document, raw);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      "Unable to parse config document.",
      "invalid_syntax",
      { path },
    );
  }
  const { config, format } = validate(value);
  return {
    path,
    revision: revisionOf(raw),
    config,
    ...(format ? { format } : {}),
    // Only a Project document has Services; a Host document never carries the field.
    ...(markers.length ? { recipeMarkers: markers } : {}),
  };
}
async function readDocument<T>(
  path: string,
  validate: Validate<T>,
): Promise<ConfigDocument<T>> {
  const { raw: _raw, ...document } = await readDocumentSource(path, validate);
  return document;
}
/** One filesystem read owns source bytes, decoding, and safe path-aware failures. */
async function readDocumentSource<T>(
  path: string,
  validate: Validate<T>,
): Promise<ConfigDocument<T> & { raw: string }> {
  try {
    const raw = await readFile(path, "utf8");
    return { ...decodeDocument(raw, path, validate), raw };
  } catch (error) {
    if (error instanceof ConfigError)
      throw new ConfigError(
        error.message,
        error.code,
        { ...error.context, path },
        `In ${path.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240)}: ${error.hint}`,
      );
    throw new ConfigError("Unable to read config document.", "read_failed", {
      path,
    });
  }
}
/** Reads one Project config; does not create, migrate, or modify it. */
export async function readProjectConfig(
  repoPath: string,
): Promise<ConfigDocument<ProjectConfig>> {
  const path = await locateConfig(resolve(repoPath), "rig");
  if (!path) {
    // A directory that is gone is a moved Project, not a Project that was never initialized.
    const present = await stat(resolve(repoPath)).then(
      () => true,
      (error) => {
        if (missing(error)) return false;
        throw error;
      },
    );
    if (!present)
      throw new ConfigError(
        `Project directory ${repoPath} does not exist.`,
        "missing_directory",
        { repoPath },
        "Run rig repoint <new path> --project <name> to register the moved directory.",
      );
    throw new ConfigError(
      "No rig.yaml found.",
      "missing_config",
      { repoPath },
      "Run rig init from the Project repository.",
    );
  }
  return readDocument(path, parseProjectDocument);
}
/** Searches upward from a directory or file, never above `boundary` when one is given (a
 * canonical directory at or above the start). Ambiguous or invalid nearer config never falls through. */
export async function discoverProject(
  startPath: string,
  boundary?: string,
): Promise<{ repoPath: string; document: ConfigDocument<ProjectConfig> }> {
  let directory = await realpath(startPath);
  if (!(await stat(directory)).isDirectory()) directory = dirname(directory);
  for (;;) {
    const path = await locateConfig(directory, "rig");
    if (path)
      return {
        repoPath: directory,
        document: await readDocument(path, parseProjectDocument),
      };
    const parent = dirname(directory);
    if (parent === directory || directory === boundary)
      throw new ConfigError(
        "No Project config found in this directory or its parents.",
        "missing_config",
        { startPath },
        "Run rig init in a repository, or select a registered Project.",
      );
    directory = parent;
  }
}
/** The format of the nearest rig.yaml at or above `startPath`, read without validating the rest; undefined when there is
 * none or it cannot be read as YAML. */
export async function findDeclaredFormat(
  startPath: string,
): Promise<ConfigFormat | undefined> {
  let directory = resolve(startPath);
  for (;;) {
    const path = await locateConfig(directory, "rig").catch(() => undefined);
    if (path) {
      try {
        return declaredFormat(
          yamlDocument(await readFile(path, "utf8"), path).toJS({
            maxAliasCount: 0,
          }),
        );
      } catch {
        return undefined;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
/** Reads Host configuration from config.yaml, returning defaults only when no Host document exists. */
export async function readHostConfig(stateRoot: string): Promise<HostConfig> {
  const path = await locateConfig(resolve(stateRoot), "config");
  return path
    ? (await readDocument(path, hostDocument)).config
    : parseHostConfig({});
}
/** Creates a new YAML document exclusively in the latest format; an existing document remains untouched. */
export async function initializeProjectConfig(
  repoPath: string,
  config: ProjectConfig,
): Promise<ConfigDocument<ProjectConfig>> {
  if (await locateConfig(repoPath, "rig"))
    throw new ConfigError(
      "Project config already exists.",
      "already_initialized",
      { repoPath },
      "Use rig config to inspect the existing Project.",
    );
  const path = join(repoPath, "rig.yaml");
  await writeFile(
    path,
    PROJECT_SCHEMA_COMMENT + stringify({ format: LATEST_FORMAT, ...config }),
    { flag: "wx" },
  );
  return readDocument(path, parseProjectDocument);
}
export interface ConfigEditInput {
  repoPath: string;
  expectedRevision: string;
  edits: readonly ConfigEdit[];
}
export interface ProjectConfigSource extends ConfigDocument<ProjectConfig> {
  raw: string;
}
/** Pure: the settings of a document Rig has already read, as written in its own format's spelling, where `config` has the
 * latest format's shape. An editor that changes the file by path works on these. */
export function writtenSettings(raw: string): unknown {
  return yamlDocument(raw, "rig.yaml").toJS({ maxAliasCount: 0 });
}
export interface ProjectConfigPreview extends ProjectConfigSource {
  baseRevision: string;
}

/** Reads the exact source and decoded config from the same bytes. */
export async function readProjectConfigSource(
  repoPath: string,
): Promise<ProjectConfigSource> {
  const path = await locateConfig(resolve(repoPath), "rig");
  if (!path)
    throw new ConfigError("No rig.yaml found.", "missing_config", {
      repoPath,
    });
  return readDocumentSource(path, parseProjectDocument);
}
function prepareEdit(
  raw: string,
  path: string,
  input: ConfigEditInput,
): ProjectConfigPreview {
  if (revisionOf(raw) !== input.expectedRevision)
    throw new ConfigError(
      "Config changed since it was read.",
      "revision_conflict",
      { path },
      "Read the current config before retrying the edit.",
    );
  const ast = yamlDocument(raw, path);
  applyYamlEdits(ast, input.edits);
  const output = ast.toString();
  return {
    ...decodeDocument(output, path, parseProjectDocument),
    raw: output,
    baseRevision: input.expectedRevision,
  };
}
/** Reads and transforms without locks, backups, or writes. Apply performs its own revision check. */
export async function previewProjectConfig(
  input: ConfigEditInput,
): Promise<ProjectConfigPreview> {
  const document = await readProjectConfigSource(input.repoPath);
  return prepareEdit(document.raw, document.path, input);
}
/** Optimistic revision checked filesystem editor. YAML edits preserve existing AST comments/order.
 * Serializes Rig writers via an exclusive lock; creates a content-addressed backup before atomic replace.
 * External editors do not honor the lock; a second revision check detects edits before replacement.
 * A symlinked `rig.yaml` is written through: the linked file changes and the link stays in place.
 */
export async function editProjectConfig(
  input: ConfigEditInput,
): Promise<ProjectConfigPreview & { backupPath: string }> {
  return rewriteProjectConfig(input, (raw, path) =>
    prepareEdit(raw, path, input),
  );
}
/** The locked, revision-checked, backed-up atomic replacement every Rig writer of rig.yaml uses; `prepare` turns the text
 * read under the lock into the text to write. */
async function rewriteProjectConfig(
  input: Pick<ConfigEditInput, "repoPath" | "expectedRevision">,
  prepare: (raw: string, path: string) => ProjectConfigPreview,
): Promise<ProjectConfigPreview & { backupPath: string }> {
  const document = await readProjectConfig(input.repoPath),
    file = await realpath(document.path),
    lockPath = `${file}.lock`;
  const acquired = await acquireProcessLock(lockPath);
  if ("held" in acquired) throw configLocked(document.path, acquired.held);
  const { lock } = acquired;
  let temporary: string | undefined;
  try {
    const raw = await readFile(file, "utf8");
    const prepared = prepare(raw, document.path);
    const output = prepared.raw;
    // One backup per file, replaced on every edit: the text before the latest change, never a growing set.
    const backupPath = `${file}.bak`;
    const backupTemporary = `${file}.${randomUUID()}.bak.tmp`;
    await writeFile(backupTemporary, raw, { flag: "wx", mode: 0o600 });
    await rename(backupTemporary, backupPath);
    temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, output, {
      flag: "wx",
      mode: (await stat(file)).mode,
    });
    if (revisionOf(await readFile(file, "utf8")) !== input.expectedRevision)
      throw new ConfigError(
        "Config changed during editing.",
        "revision_conflict",
        { path: document.path },
      );
    await rename(temporary, file);
    temporary = undefined;
    return {
      ...prepared,
      backupPath,
    };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
/** What `rig config upgrade` did, or with `dryRun` would do, to one rig.yaml. */
export interface ConfigUpgrade {
  path: string;
  /** The format the file was written in. */
  from: ConfigFormat;
  /** The format it is written in now, or would be. */
  to: ConfigFormat;
  /** Each change in words; empty when the file already has the latest format. */
  changes: string[];
  /** A unified diff of the file; empty when nothing changes. */
  diff: string;
  /** Whether the file was rewritten; never with `dryRun`. */
  written: boolean;
  /** The text before the upgrade, when it was written. */
  backupPath?: string;
}
/** Rewrites one Project's rig.yaml into the latest format in place, keeping comments and layout, or with `dryRun` only
 * reports what would change. The result is checked before anything is written: it must parse in the latest format to the
 * same config the file had, so no plan changes. The write is the config editor's: locked, revision-checked, with a
 * rig.yaml.bak backup. Only the file is touched: nothing is committed, planned or restarted. */
export async function upgradeProjectConfig(input: {
  repoPath: string;
  dryRun: boolean;
}): Promise<ConfigUpgrade> {
  const current = await readProjectConfigSource(input.repoPath);
  const from = current.format ?? LATEST_FORMAT;
  const prepared = prepareUpgrade(current);
  const report = {
    path: current.path,
    from,
    to: LATEST_FORMAT,
    changes: prepared.changes,
    diff: unifiedDiff(current.raw, prepared.raw, "rig.yaml"),
  };
  if (input.dryRun || !prepared.changes.length)
    return { ...report, written: false };
  const written = await rewriteProjectConfig(
    { repoPath: input.repoPath, expectedRevision: current.revision },
    (raw, path) => {
      if (revisionOf(raw) !== current.revision)
        throw new ConfigError(
          "Config changed since it was read.",
          "revision_conflict",
          { path },
          "Run rig config upgrade again.",
        );
      return { ...prepared.document, baseRevision: current.revision };
    },
  );
  return { ...report, written: true, backupPath: written.backupPath };
}
/** Pure: the upgraded text of one read document and its changes, refused unless it reads back as the same config. */
function prepareUpgrade(current: ProjectConfigSource): {
  raw: string;
  changes: string[];
  document: ProjectConfigSource;
} {
  const { raw, changes } = upgradeYamlText(
    current.raw,
    current.format ?? LATEST_FORMAT,
  );
  if (!changes.length) return { raw, changes, document: current };
  const document = {
    ...decodeDocument(raw, current.path, parseProjectDocument),
    raw,
  };
  if (
    document.format !== LATEST_FORMAT ||
    !isDeepStrictEqual(document.config, current.config)
  )
    throw new ConfigError(
      "The upgraded rig.yaml would not mean what the current one does, so it was not written.",
      "upgrade_mismatch",
      { path: current.path },
      "Report this as a Rig bug with the rig.yaml attached; meanwhile move ready and ready_timeout under health by hand and set format: rig/v2.",
    );
  return { raw, changes, document };
}
/** A lock held by a live edit, or too fresh to reclaim, is refused with the file an operator can inspect or remove. */
function configLocked(path: string, held: LockHeld): ConfigError {
  const cause =
    held.reason === "alive"
      ? `is held by pid ${held.pid}, which is alive. Wait for that edit to finish; if no rig config edit is running, remove ${held.lockPath} and retry.`
      : held.reason === "fresh"
        ? `was taken less than a minute ago by an edit that recorded no pid. Wait for it; if no rig config edit is running, remove ${held.lockPath} and retry.`
        : "was taken again while it was being reclaimed. Retry.";
  return new ConfigError(
    "Config is being edited by another operation.",
    "config_locked",
    { path, lockPath: held.lockPath, ...(held.pid ? { pid: held.pid } : {}) },
    `The config lock at ${held.lockPath} ${cause}`,
  );
}
export interface InitializeProjectInput {
  name: string;
  productionBranch?: string;
  domain?: string;
  service?: { name: string; run: string; port?: number; ready?: string };
  tool?: { name: string; bin: string; build?: string };
}
/** Pure initial Project policy in the latest format: one optional Service, routed at '/' when a domain is given, and one
 * optional Tool. A Service's `ready` becomes its health.check. */
export function scaffoldProjectConfig(
  input: InitializeProjectInput,
): ProjectConfig {
  const { service, tool } = input;
  if (!service && !tool)
    throw new ConfigError(
      "A new Project needs a Service or a Tool.",
      "empty_project",
      {},
      "Pass --service <name> --run <command>, or --tool <name> --bin <path>; or write rig.yaml first and run rig init again.",
    );
  return parseProjectConfig({
    format: LATEST_FORMAT,
    name: input.name,
    production_branch: input.productionBranch ?? "main",
    ...(input.domain ? { domain: input.domain } : {}),
    ...(service
      ? {
          services: {
            [service.name]: {
              run: service.run,
              ports: { http: service.port ?? "auto" },
              ...(service.ready ? { health: { check: service.ready } } : {}),
            },
          },
        }
      : {}),
    ...(tool
      ? {
          tools: {
            [tool.name]: {
              ...(tool.build ? { build: tool.build } : {}),
              bin: tool.bin,
            },
          },
        }
      : {}),
    ...(service && input.domain
      ? { proxy: { "/": `\${services.${service.name}.ports.http}` } }
      : {}),
    targets: {
      working: { name: DEFAULT_TARGET_NAMES.working },
      stable: { name: DEFAULT_TARGET_NAMES.stable },
    },
  });
}
