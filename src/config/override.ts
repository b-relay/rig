type Fields = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Applies a lane's Component override to the shared definition: fields replace, while env and hooks merge per key,
 * so a lane may add or replace one hook or variable without restating the rest. */
export function mergeComponentOverride(
  base: Fields,
  patch: Fields | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...patch };
  for (const key of ["env", "hooks"])
    if (isRecord(base[key]) && isRecord(patch?.[key]))
      merged[key] = { ...base[key], ...patch[key] };
  return merged;
}
