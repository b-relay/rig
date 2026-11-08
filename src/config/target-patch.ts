import type { ProjectConfig } from "./project-fields";
import { isRecord, type Fields } from "./record";
import type { TargetRole } from "./target-roles";

/** Project settings with one role's patch applied; the Target switches never merge into them. */
export type ProjectSettings = Omit<ProjectConfig, "targets">;
export function patchedSettings(
  config: ProjectConfig,
  role: TargetRole,
): ProjectSettings {
  return patchSettings(config, role) as ProjectSettings;
}
/** The settings one role may patch. */
export type RolePatch = Exclude<
  NonNullable<ProjectConfig["targets"]>[TargetRole],
  boolean | undefined
>;
/** One role's settings patch: its map, or nothing when the role is only switched on or off. */
export function rolePatch(config: ProjectConfig, role: TargetRole): RolePatch {
  const patch = config.targets?.[role];
  return isRecord(patch) ? patch : {};
}
/** The patch rule: the base settings, without the Target switches, merged with one role's patch. It reads any mapping, so
 * validation can apply it to a document whose patches it has not yet judged. */
export function patchSettings(config: Fields, role: TargetRole): Fields {
  const { targets, ...base } = config;
  const patch: Record<string, unknown> = {
    ...(isRecord(targets) && isRecord(targets[role]) ? targets[role] : {}),
  };
  // A patch naming an unknown entry is reported by validation; merging would otherwise invent a partial entry.
  for (const kind of ["services", "tools"] as const)
    if (isRecord(patch[kind]))
      patch[kind] = Object.fromEntries(
        Object.entries(patch[kind]).filter(([key]) =>
          Object.hasOwn(isRecord(base[kind]) ? base[kind] : {}, key),
        ),
      );
  const merged = mergeSettings(base, patch);
  // `build: false` in a patch turns the inherited build off: the role's settings have none.
  const unbuilt = (settings: Record<string, unknown>) => {
    if (settings.build === false) delete settings.build;
  };
  unbuilt(merged);
  if (isRecord(merged.services))
    for (const service of Object.values(merged.services))
      if (isRecord(service)) unbuilt(service as Record<string, unknown>);
  return merged;
}
/** Settings patch rule: maps merge per key, lists and scalars replace. */
function mergeSettings(base: Fields, patch: Fields): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch))
    merged[key] =
      isRecord(merged[key]) && isRecord(value)
        ? mergeSettings(merged[key], value)
        : value;
  return merged;
}
