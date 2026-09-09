import { createHash, randomUUID } from "node:crypto";
import {
  access,
  readFile,
  writeFile,
  rename,
  unlink,
  open,
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
import { ConfigError } from "./errors.js";
import { applyJsonEdits, applyYamlEdits, type ConfigEdit } from "./editor.js";
export type { ConfigEdit } from "./editor.js";
import { parseHostConfig, parseProjectConfig } from "./schema.js";
import type { ConfigDocument, HostConfig, ProjectConfig } from "./types.js";
const revisionOf = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
/** Filesystem effect owner: probes both canonical names, preserving permission failures. */
async function locateConfig(
  directory: string,
  stem: string,
): Promise<string | undefined> {
  const candidates = [
    join(directory, `${stem}.yaml`),
    join(directory, `${stem}.json`),
  ];
  const found = (
    await Promise.all(
      candidates.map(async (path) => {
        try {
          await access(path);
          return path;
        } catch (error) {
          if (missing(error)) return undefined;
          throw new ConfigError(
            "Unable to inspect config document.",
            "read_failed",
            { path },
          );
        }
      }),
    )
  ).filter((path): path is string => !!path);
  if (found.length > 1)
    throw new ConfigError(
      "Both YAML and JSON config documents exist.",
      "ambiguous_config",
      { paths: found },
      "Keep exactly one .yaml or .json config document; Rig will not choose or merge them.",
    );
  return found[0];
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
  validate: (value: unknown) => T,
): ConfigDocument<T> {
  const format = path.endsWith(".yaml") ? "yaml" : "json";
  let value: unknown;
  try {
    value =
      format === "yaml"
        ? yamlDocument(raw, path).toJS({ maxAliasCount: 0 })
        : JSON.parse(raw);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      "Unable to parse config document.",
      "invalid_syntax",
      { path },
    );
  }
  return { path, format, revision: revisionOf(raw), config: validate(value) };
}
async function readDocument<T>(
  path: string,
  validate: (value: unknown) => T,
): Promise<ConfigDocument<T>> {
  const { raw, ...document } = await readDocumentSource(path, validate);
  return document;
}
/** One filesystem read owns source bytes, decoding, and safe path-aware failures. */
async function readDocumentSource<T>(
  path: string,
  validate: (value: unknown) => T,
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
  if (!path)
    throw new ConfigError(
      "No rig.yaml or rig.json found.",
      "missing_config",
      { repoPath },
      "Run rig init from the Project repository.",
    );
  return readDocument(path, parseProjectConfig);
}
/** Searches upward from a directory or file. Ambiguous or invalid nearer config never falls through. */
export async function discoverProject(
  startPath: string,
): Promise<{ repoPath: string; document: ConfigDocument<ProjectConfig> }> {
  let directory = await realpath(startPath);
  if (!(await stat(directory)).isDirectory()) directory = dirname(directory);
  for (;;) {
    const path = await locateConfig(directory, "rig");
    if (path)
      return {
        repoPath: directory,
        document: await readDocument(path, parseProjectConfig),
      };
    const parent = dirname(directory);
    if (parent === directory)
      throw new ConfigError(
        "No Project config found in this directory or its parents.",
        "missing_config",
        { startPath },
        "Run rig init in a repository, or select a registered Project.",
      );
    directory = parent;
  }
}
/** Reads Host configuration, returning defaults only when neither canonical document exists. */
export async function readHostConfig(stateRoot: string): Promise<HostConfig> {
  const path = await locateConfig(resolve(stateRoot), "config");
  return path
    ? (await readDocument(path, parseHostConfig)).config
    : parseHostConfig({});
}
/** Creates a new canonical YAML document exclusively; existing JSON or YAML remains untouched. */
export async function initializeProjectConfig(
  repoPath: string,
  input: InitializeProjectInput,
): Promise<ConfigDocument<ProjectConfig>> {
  if (await locateConfig(repoPath, "rig"))
    throw new ConfigError(
      "Project config already exists.",
      "already_initialized",
      { repoPath },
      "Use rig config to inspect the existing Project.",
    );
  const config = scaffoldProjectConfig(input);
  const path = join(repoPath, "rig.yaml");
  await writeFile(path, stringify(config), { flag: "wx" });
  return readDocument(path, parseProjectConfig);
}
export interface ConfigEditInput {
  repoPath: string;
  expectedRevision: string;
  edits: readonly ConfigEdit[];
}
export interface ProjectConfigSource extends ConfigDocument<ProjectConfig> {
  raw: string;
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
    throw new ConfigError("No rig.yaml or rig.json found.", "missing_config", {
      repoPath,
    });
  return readDocumentSource(path, parseProjectConfig);
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
  let output: string;
  if (path.endsWith(".yaml")) {
    const ast = yamlDocument(raw, path);
    applyYamlEdits(ast, input.edits);
    output = ast.toString();
  } else {
    const config: Record<string, unknown> = JSON.parse(raw);
    applyJsonEdits(config, input.edits);
    output = JSON.stringify(config, null, 2) + "\n";
  }
  return {
    ...decodeDocument(output, path, parseProjectConfig),
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
 */
export async function editProjectConfig(
  input: ConfigEditInput,
): Promise<ProjectConfigPreview & { backupPath: string }> {
  const document = await readProjectConfig(input.repoPath),
    lockPath = `${document.path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch {
    throw new ConfigError(
      "Config is being edited by another operation.",
      "config_locked",
      { path: document.path },
      "Retry after the other config edit completes.",
    );
  }
  let temporary: string | undefined;
  try {
    const raw = await readFile(document.path, "utf8");
    const prepared = prepareEdit(raw, document.path, input);
    const output = prepared.raw;
    const backupPath = `${document.path}.${input.expectedRevision}.bak`;
    try {
      await writeFile(backupPath, raw, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      if ((await readFile(backupPath, "utf8")) !== raw)
        throw new ConfigError(
          "Existing config backup does not match the revision.",
          "backup_conflict",
          { backupPath },
        );
    }
    temporary = `${document.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, output, {
      flag: "wx",
      mode: (await stat(document.path)).mode,
    });
    if (
      revisionOf(await readFile(document.path, "utf8")) !==
      input.expectedRevision
    )
      throw new ConfigError(
        "Config changed during editing.",
        "revision_conflict",
        { path: document.path },
      );
    await rename(temporary, document.path);
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
export interface InitializeProjectInput {
  name: string;
  productionBranch?: string;
  domain?: string;
  proxy?: string;
  uses?: readonly ("sqlite" | "postgres" | "convex")[];
  managed?: { name: string; command: string; port?: number; health?: string };
  installed?: {
    name: string;
    entrypoint: string;
    build?: string;
    installName?: string;
  };
}
/** Pure initial Project policy. Initialization never replaces an existing document. */
export function scaffoldProjectConfig(
  input: InitializeProjectInput,
): ProjectConfig {
  const components: Record<string, unknown> = {};
  for (const uses of input.uses ?? []) components[uses] = { uses };
  if (input.managed) {
    const { name, ...fields } = input.managed;
    if (components[name])
      throw new ConfigError(
        "Initial Component names must be unique.",
        "duplicate_component",
        { name },
      );
    components[name] = { mode: "managed", ...fields };
  }
  if (input.installed) {
    const { name, ...fields } = input.installed;
    if (components[name])
      throw new ConfigError(
        "Initial Component names must be unique.",
        "duplicate_component",
        { name },
      );
    components[name] = { mode: "installed", ...fields };
  }
  const proxy = input.proxy ? { proxy: { upstream: input.proxy } } : {};
  return parseProjectConfig({
    name: input.name,
    ...(input.domain ? { domain: input.domain } : {}),
    components,
    local: { ...proxy },
    live: { deployBranch: input.productionBranch ?? "main", ...proxy },
    deployments: { subdomain: "${branchSlug}", ...proxy },
  });
}
