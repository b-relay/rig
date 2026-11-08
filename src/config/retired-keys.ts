import { isRecord, type Fields } from "./record";
import { RENAMED_RULE, type Issue } from "./validation-messages";

// rig.yaml keys Rig retired or renamed, and shapes it refuses, each with guidance that names the fix instead of calling the
// key unknown.

/** Keys a Target patch may not set, with why. */
const PATCH_IDENTITY_KEYS: Readonly<Record<string, string>> = {
  production_branch:
    "The Production branch is Project-wide; set production_branch at the top level.",
  description: "The Project description is not a Target setting.",
  targets: "A Target patch cannot contain targets.",
  role: "A Target's role is its fixed key (working, stable or preview) and cannot change.",
  // Rig once let rig.yaml rename the working and stable Targets (ADR 0006); ADR 0010 fixed their names.
  name: "Target names are fixed (working, stable, preview); delete this line.",
};
/** `supervisor` chose between rigd and per-Service launchd agents until launchd supervision was removed; rigd now supervises
 * every Service, so a file that still sets it is told to delete the line rather than that the field is unknown. */
const REMOVED_SUPERVISOR =
  "was removed because rigd supervises every Service; delete this line";
/** `format` named a rig.yaml format until Rig read more than one; there is one format now, so the key is refused with that
 * instruction rather than as an unknown field. */
const REMOVED_FORMAT =
  "was removed because Rig reads one rig.yaml format; delete this line";
/** A Service's `health` block held its start check and ongoing health checks until ADR 0009 removed both; ADR 0012 brought
 * them back as Docker Compose's `healthcheck`, so a file that still has the block is told where its settings go. */
const REMOVED_HEALTH =
  "`health` is now `healthcheck`, in Docker Compose's shape: write check as test, start_timeout as start_period and failures as retries; interval, timeout and on_failure keep their names, and retry_for is gone";
/** `ready` and `ready_timeout` were a Service's start check until ADR 0012 replaced them with Compose's `healthcheck`. */
const SERVICE_MOVES: Readonly<Record<string, string>> = {
  ready: "`ready` is now `healthcheck.test`; move it there",
  ready_timeout: "`ready_timeout` is now `healthcheck.start_period`",
};
/** Keys renamed to their Docker Compose names (ADR 0011). A file that still uses the old name is told the new one rather than
 * that the key is unknown. Project settings and a Target patch had `env`; a Service had `run` and `env`. */
const SETTINGS_RENAMES: Readonly<Record<string, string>> = {
  env: "environment",
};
const SERVICE_RENAMES: Readonly<Record<string, string>> = {
  run: "command",
  ...SETTINGS_RENAMES,
};
const renamedKey = (from: string, to: string) =>
  `\`${from}\` is now \`${to}\`; rename this key`;
/** `build: false` only means something against a build a Target patch inherits; at the top level leaving the key out
 * already means no build. */
const BASE_BUILD_OFF =
  "build: false only turns an inherited build off in a Target patch; delete this line for no build";
/** A Tool's build makes its bin, so it cannot be turned off; only the Project build and a Service build can. */
const TOOL_BUILD_OFF =
  "build: false is not allowed for a Tool, whose build makes its bin; give another command or leave the key out";
/** Every Service mapping of a raw config value with its path: `services.<name>` and `targets.<role>.services.<name>`. */
function serviceBlockPaths(value: Fields): [string[], Fields][] {
  const blocks: [string[], Fields][] = [];
  const collect = (services: unknown, at: string[]) => {
    if (isRecord(services))
      for (const [name, service] of Object.entries(services))
        if (isRecord(service)) blocks.push([[...at, name], service]);
  };
  collect(value.services, ["services"]);
  if (isRecord(value.targets))
    for (const [role, patch] of Object.entries(value.targets))
      if (isRecord(patch))
        collect(patch.services, ["targets", role, "services"]);
  return blocks;
}
/** Refusals that need their own guidance, checked before the schema so they are not reported as generic unknown keys.
 * Empty when the document has none; its other problems are the schema's to find. */
export function unsupportedShapeIssues(value: unknown): Issue[] {
  if (!isRecord(value)) return [];
  const issues: Issue[] = [];
  if (Object.hasOwn(value, "format"))
    issues.push({ path: ["format"], message: REMOVED_FORMAT });
  if (Object.hasOwn(value, "supervisor"))
    issues.push({ path: ["supervisor"], message: REMOVED_SUPERVISOR });
  const renames = (
    block: Fields,
    at: string[],
    names: Readonly<Record<string, string>>,
  ) => {
    for (const [from, to] of Object.entries(names))
      if (Object.hasOwn(block, from))
        issues.push({
          path: [...at, from],
          message: renamedKey(from, to),
          rule: RENAMED_RULE,
        });
  };
  renames(value, [], SETTINGS_RENAMES);
  const builds: [string[], unknown][] = [[["build"], value.build]];
  if (isRecord(value.services))
    for (const [name, service] of Object.entries(value.services))
      if (isRecord(service))
        builds.push([["services", name, "build"], service.build]);
  for (const [path, build] of builds)
    if (build === false) issues.push({ path, message: BASE_BUILD_OFF });
  // A Tool's bin comes from its build, so no role may turn a Tool build off.
  const toolBlocks: [string[], unknown][] = [[["tools"], value.tools]];
  if (isRecord(value.targets))
    for (const [role, patch] of Object.entries(value.targets))
      if (isRecord(patch))
        toolBlocks.push([["targets", role, "tools"], patch.tools]);
  for (const [at, tools] of toolBlocks)
    if (isRecord(tools))
      for (const [name, tool] of Object.entries(tools))
        if (isRecord(tool) && tool.build === false)
          issues.push({
            path: [...at, name, "build"],
            message: TOOL_BUILD_OFF,
          });
  for (const [path, service] of serviceBlockPaths(value)) {
    if (Object.hasOwn(service, "health"))
      issues.push({
        path: [...path, "health"],
        message: REMOVED_HEALTH,
        rule: RENAMED_RULE,
      });
    // Renamed like run and env (ADR 0011), so a deployed revision that still has them is told apart from a broken file.
    for (const [key, message] of Object.entries(SERVICE_MOVES))
      if (Object.hasOwn(service, key))
        issues.push({ path: [...path, key], message, rule: RENAMED_RULE });
    renames(service, path, SERVICE_RENAMES);
  }
  // A job takes a Service's Compose names, so a job written with Rig's old ones is told the new ones too. Jobs came after
  // the rename, so no committed revision can hold such a job: it is an ordinary mistake, not the renamed rule.
  if (isRecord(value.jobs))
    for (const [name, job] of Object.entries(value.jobs))
      if (isRecord(job))
        for (const [from, to] of Object.entries(SERVICE_RENAMES))
          if (Object.hasOwn(job, from))
            issues.push({
              path: ["jobs", name, from],
              message: renamedKey(from, to),
            });
  for (const [role, patch] of Object.entries(
    isRecord(value.targets) ? value.targets : {},
  )) {
    if (!isRecord(patch)) continue;
    renames(patch, ["targets", role], SETTINGS_RENAMES);
    if (Object.hasOwn(patch, "supervisor"))
      issues.push({
        path: ["targets", role, "supervisor"],
        message: REMOVED_SUPERVISOR,
      });
    for (const [key, message] of Object.entries(PATCH_IDENTITY_KEYS))
      if (Object.hasOwn(patch, key))
        issues.push({
          path: ["targets", role, key],
          // A role that held only its name, as rig init used to write it, would be left empty and so off.
          message:
            key === "name" && Object.keys(patch).length === 1
              ? `${message.replace(/\.$/, "")}, and write \`${role}: true\` to keep it on.`
              : message,
        });
    for (const kind of ["services", "tools"])
      if (isRecord(patch[kind]))
        for (const [key, entry] of Object.entries(patch[kind]))
          if (entry === null)
            issues.push({
              path: ["targets", role, kind, key],
              message:
                "Removing or disabling an inherited Service or Tool in a Target patch is not supported.",
            });
  }
  return issues;
}
