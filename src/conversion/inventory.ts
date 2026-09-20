import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { hostConfigSchema, projectConfigSchema } from "../config/index";
import { runtimeStateSchema, STATE_VERSION } from "../runtime/state-schema";
import { legacyProjectSchema } from "./legacy-project";
import { legacyStateSchema, type LegacyState } from "./legacy-state";
import { convertTarget, type Blocker, type TargetMapping } from "./plan";
import { projectCandidate, type ProjectCandidate } from "./project-yaml";
import type { Review } from "./review";

/** Bumped whenever the mapping changes, so a revision reviewed under another mapping is never applied. */
const CONVERTER = 1;
/** Root metadata the backup copies byte for byte. Data, logs, sources, published Tools and the control-plane token are
 * never copied: the conversion does not touch them. */
const METADATA = [
  "config.json",
  "config.yaml",
  "runtime/state.json",
  "runtime/state.json.bak",
  "installed",
  "process-leases",
  "capture",
  "launchd",
  "proxy/Caddyfile",
  "effect-checkpoints",
  "daemon/owner.json",
];
export interface ConversionDeps {
  /** Whether a recorded pid is a live process. A reused pid reads as alive, which only ever blocks. */
  pidAlive(pid: number): boolean;
  now(): string;
  /** Named points between the writes of `applyConversion`; a test makes one throw to leave a partial conversion. */
  checkpoint?(step: "backup" | "publish"): void | Promise<void>;
}
export interface EvidenceFile {
  relativePath: string;
  sha256: string;
  size: number;
  contents: Buffer;
}
export interface ProjectInventory {
  id: string;
  name: string;
  repoPath: string;
  /** `legacy`: a retired config a candidate is made from. `current`: already a valid rig.yaml. */
  config: "legacy" | "current";
  configPath: string;
  candidate?: ProjectCandidate;
}
/** Everything a preview knows. Safe to print: key names, paths, commands and digests; never an env-file value. */
export interface ConversionPreview {
  root: string;
  /** `legacy`: there is something to convert. `converted`: the state is already the new format. `empty`: no state. */
  status: "legacy" | "converted" | "empty";
  revision: string;
  blockers: Blocker[];
  warnings: string[];
  projects: ProjectInventory[];
  targets: TargetMapping[];
  /** A Host config.json: shown as the config.yaml the operator has to put in place; the conversion never writes it. */
  host?: { from: string; to: string; candidate?: string };
  evidence: {
    files: Omit<EvidenceFile, "contents">[];
    dataPaths: { path: string; present: boolean }[];
    toolOwners: { file: string; targetId?: string; component?: string }[];
    processes: { file: string; pid: number; alive: boolean }[];
    effectJournals: string[];
  };
  activate: string[];
}
/** What `applyConversion` writes, kept off the printable preview. */
export interface ConversionWork {
  preview: ConversionPreview;
  files: EvidenceFile[];
  state?: unknown;
}
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const absent = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
async function optional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
}
async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}
async function collect(root: string, entry: string): Promise<EvidenceFile[]> {
  const path = join(root, entry);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
  if (info.isDirectory()) {
    const files: EvidenceFile[] = [];
    for (const name of (await readdir(path)).sort())
      files.push(...(await collect(root, join(entry, name))));
    return files;
  }
  if (!info.isFile()) return [];
  const contents = await readFile(path);
  return [
    {
      relativePath: entry.split(sep).join("/"),
      sha256: digest(contents),
      size: contents.length,
      contents,
    },
  ];
}

/** Read-only inspection of a Rig root written by the retired runtime, and of what a conversion under `review` would do.
 * Reads the root's metadata and each registered repository's config; opens no socket, signals no process beyond the
 * injected liveness probe, and writes nothing. Env files are never opened. */
export async function readConversion(
  root: string,
  review: Review,
  deps: ConversionDeps,
): Promise<ConversionWork> {
  root = resolve(root);
  const files = (
      await Promise.all(METADATA.map((entry) => collect(root, entry)))
    ).flat(),
    blockers: Blocker[] = [],
    warnings: string[] = [],
    raw = files.find((file) => file.relativePath === "runtime/state.json");
  const preview: ConversionPreview = {
    root,
    status: "empty",
    revision: "",
    blockers,
    warnings,
    projects: [],
    targets: [],
    evidence: {
      files: files.map(({ contents: _contents, ...file }) => file),
      dataPaths: [],
      toolOwners: [],
      processes: [],
      effectJournals: [],
    },
    activate: review.activate,
  };
  const general = (code: string, message: string, subject?: string) =>
    blockers.push({
      code,
      project: "",
      ...(subject ? { subject } : {}),
      message,
    });
  const inputs: string[] = [
    `converter:${CONVERTER}`,
    `review:${digest(JSON.stringify(review))}`,
  ];

  // Liveness: the retired daemon and everything it supervised must be stopped by the retired runtime first.
  for (const file of files) {
    const recorded =
      file.relativePath === "daemon/owner.json" ||
      file.relativePath.startsWith("process-leases/");
    if (!recorded || !file.relativePath.endsWith(".json")) continue;
    const pid = pidOf(file.contents);
    if (pid === undefined) continue;
    const alive = deps.pidAlive(pid);
    preview.evidence.processes.push({ file: file.relativePath, pid, alive });
    if (!alive) continue;
    if (file.relativePath === "daemon/owner.json")
      general(
        "daemon_running",
        `A rigd (pid ${pid}) owns this root. Stop it with the rigd that started it (rigd uninstall); two daemons never share a root.`,
        file.relativePath,
      );
    else
      general(
        "live_process",
        `${file.relativePath} records a live process (pid ${pid}). Stop its Target with the runtime that started it before converting.`,
        file.relativePath,
      );
  }
  for (const file of files)
    if (/^effect-checkpoints\/[^/]+\/journal\.json$/.test(file.relativePath)) {
      preview.evidence.effectJournals.push(file.relativePath);
      general(
        "unresolved_effects",
        `${file.relativePath} is an unfinished operation of the retired runtime. Start that runtime once so it settles the operation, then stop it again.`,
        file.relativePath,
      );
    }

  let legacy: LegacyState | undefined;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.contents.toString("utf8"));
    } catch {
      general("state_invalid", "runtime/state.json is not JSON.");
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === STATE_VERSION
    )
      preview.status = "converted";
    else if (parsed !== undefined) {
      const result = legacyStateSchema.safeParse(parsed);
      if (result.success) {
        legacy = result.data;
        preview.status = "legacy";
      } else
        general(
          "state_invalid",
          `runtime/state.json is not a version 2 or 3 state file: ${result.error.issues[0]?.path.join(".")} ${result.error.issues[0]?.message}.`,
        );
    }
    inputs.push(`state:${raw.sha256}`);
  }

  const work: ConversionWork = { preview, files };
  const hostJson = files.find((file) => file.relativePath === "config.json");
  if (hostJson && preview.status !== "converted") {
    const candidate = hostCandidate(hostJson.contents);
    preview.host = {
      from: join(root, "config.json"),
      to: join(root, "config.yaml"),
      ...(typeof candidate === "string" ? { candidate } : {}),
    };
    general(
      "host_config",
      typeof candidate === "string"
        ? "The Host configuration is config.json, which the new runtime refuses. Rig never rewrites a config: save the candidate as config.yaml (the retired runtime reads it too), remove config.json, and preview again."
        : candidate.problem,
      "config.json",
    );
  }

  if (legacy) {
    const targetIds = new Set(legacy.targets.map((target) => target.id));
    for (const file of files) {
      if (!/^installed\/owners\/[^/]+\.json$/.test(file.relativePath)) continue;
      inputs.push(`owner:${file.relativePath}:${file.sha256}`);
      const owner = ownerOf(file.contents);
      preview.evidence.toolOwners.push({ file: file.relativePath, ...owner });
      if (!owner.targetId || !targetIds.has(owner.targetId))
        general(
          "ambiguous_ownership",
          `${file.relativePath} says a published Tool belongs to a Target this root does not record. Remove the Tool with the runtime that published it, or restore the Target's record.`,
          file.relativePath,
        );
    }
    const projects = new Map(legacy.projects.map((p) => [p.id, p]));
    for (const project of legacy.projects) {
      const located = await locateProjectConfig(project.repoPath);
      if (!located) {
        blockers.push({
          code: "project_config",
          project: project.name,
          subject: project.repoPath,
          message: `No rig.json or rig.yaml is readable in ${project.repoPath}, so nothing says what ${project.name} is. Repoint or forget the Project with the runtime that registered it.`,
        });
        continue;
      }
      inputs.push(`project:${project.id}:${digest(located.contents)}`);
      const entry = projectEntry(project, located, review, join(root, "env"));
      if ("problem" in entry)
        blockers.push({
          code: "project_config",
          project: project.name,
          subject: located.path,
          message: entry.problem,
        });
      else preview.projects.push(entry);
    }
    const converted: unknown[] = [];
    for (const target of legacy.targets) {
      const result = convertTarget(target, review);
      converted.push(result.target);
      preview.targets.push(result.mapping);
      blockers.push(...result.blockers);
      warnings.push(...result.warnings);
      const at = { project: result.mapping.project, target: target.name };
      if (!projects.has(target.projectId))
        blockers.push({
          ...at,
          code: "ambiguous_ownership",
          message: `${target.name} belongs to a Project this root does not record.`,
        });
      const dataPresent = await present(target.plan.dataRoot);
      preview.evidence.dataPaths.push({
        path: target.plan.dataRoot,
        present: dataPresent,
      });
      if (!dataPresent)
        warnings.push(
          `${at.project}/${target.name}: has no data directory yet (${target.plan.dataRoot}). Rig creates it when the Target starts. If this Target did store data, restore that directory before converting.`,
        );
      if (
        target.kind !== "local" &&
        !(await present(target.plan.workspacePath))
      )
        blockers.push({
          ...at,
          code: "missing_evidence",
          subject: target.plan.workspacePath,
          message: `The checked-out Commit ${target.plan.workspacePath} of ${target.name} is gone, so its saved Deployment cannot be what the record says. Redeploy it with the runtime that recorded it.`,
        });
    }
    blockers.push(...overlappingDataRoots(legacy));
    const state = {
      ...legacy,
      version: STATE_VERSION,
      projects: legacy.projects.map((project) => ({
        ...project,
        configPath: join(project.repoPath, "rig.yaml"),
      })),
      targets: converted,
    };
    const checked = runtimeStateSchema.safeParse(state);
    if (checked.success) work.state = state;
    else
      for (const issue of checked.error.issues.slice(0, 5))
        general(
          "unsupported_mapping",
          `The converted state is not valid for the new runtime: ${issue.path.join(".")} ${issue.message}.`,
          issue.path.join("."),
        );
  }
  preview.revision = digest(inputs.sort().join("\n"));
  return work;
}

function pidOf(contents: Buffer): number | undefined {
  try {
    const pid = (JSON.parse(contents.toString("utf8")) as { pid?: unknown })
      .pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0
      ? pid
      : undefined;
  } catch {
    return undefined;
  }
}
function ownerOf(contents: Buffer): { targetId?: string; component?: string } {
  try {
    const owner = JSON.parse(contents.toString("utf8")) as Record<
      string,
      unknown
    >;
    return {
      ...(typeof owner.targetId === "string"
        ? { targetId: owner.targetId }
        : {}),
      ...(typeof owner.componentName === "string"
        ? { component: owner.componentName }
        : {}),
    };
  } catch {
    return {};
  }
}
/** The Host document is the same in both formats; only its file format changed. */
function hostCandidate(contents: Buffer): string | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    return { problem: "config.json is not JSON." };
  }
  const checked = hostConfigSchema.safeParse(value);
  if (!checked.success)
    return {
      problem: `config.json is not a valid Host configuration: ${checked.error.issues[0]?.path.join(".")} ${checked.error.issues[0]?.message}.`,
    };
  return stringify(value);
}
async function locateProjectConfig(
  repoPath: string,
): Promise<{ path: string; contents: Buffer } | undefined> {
  for (const name of ["rig.json", "rig.yaml"]) {
    const path = join(repoPath, name),
      contents = await optional(path);
    if (contents) return { path, contents };
  }
  return undefined;
}
function projectEntry(
  project: { id: string; name: string; repoPath: string },
  located: { path: string; contents: Buffer },
  review: Review,
  envRoot: string,
): ProjectInventory | { problem: string } {
  let value: unknown;
  try {
    value = parseYaml(located.contents.toString("utf8"));
  } catch {
    return { problem: `${located.path} cannot be parsed.` };
  }
  const base = {
    id: project.id,
    name: project.name,
    repoPath: project.repoPath,
    configPath: located.path,
  };
  const legacy = legacyProjectSchema.safeParse(value);
  if (legacy.success)
    return {
      ...base,
      config: "legacy",
      candidate: projectCandidate(legacy.data, review, envRoot),
    };
  if (
    !located.path.endsWith(".json") &&
    projectConfigSchema.safeParse(value).success
  )
    return { ...base, config: "current" };
  return {
    problem: `${located.path} is neither the retired configuration nor a valid rig.yaml: ${legacy.error.issues[0]?.path.join(".")} ${legacy.error.issues[0]?.message}.`,
  };
}
/** Two Targets must never share data: equal or nested data directories make one Target's data another's. */
function overlappingDataRoots(state: LegacyState): Blocker[] {
  const blockers: Blocker[] = [],
    names = new Map(
      state.projects.map((project) => [project.id, project.name]),
    );
  for (const [index, first] of state.targets.entries())
    for (const second of state.targets.slice(index + 1)) {
      const between = relative(
        resolve(first.plan.dataRoot),
        resolve(second.plan.dataRoot),
      );
      const back = relative(
        resolve(second.plan.dataRoot),
        resolve(first.plan.dataRoot),
      );
      if (between.startsWith("..") && back.startsWith("..")) continue;
      blockers.push({
        code: "data_root_overlap",
        project: names.get(second.projectId) ?? "",
        target: second.name,
        subject: second.plan.dataRoot,
        message: `The data directories of ${first.name} (${first.plan.dataRoot}) and ${second.name} (${second.plan.dataRoot}) overlap, so neither owns its data.`,
      });
    }
  return blockers;
}
