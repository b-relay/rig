/** Which files in a Target's log directory are Target logs, and how rotated generations belong together. */

/** A Target log file: its family (the name of the file its writer appends to) and generation (0 for that current file,
 * N for `<family>.N`, which grows older as N grows). */
export interface LogSource {
  readonly name: string;
  readonly family: string;
  readonly generation: number;
}
/** What every entry of a family shares when the files themselves carry no record structure. */
export interface FamilyEvidence {
  readonly component: string;
  readonly stream: "stdout" | "stderr" | "unknown";
}

const wrapperLog = /^([a-zA-Z0-9_-]+)\.(stdout|stderr)\.log$/;
const launchdLog = /^([a-zA-Z0-9_-]+)\.launchd\.log$/;
const rotated = /^(.+)\.([1-9]\d{0,2})$/;
/** Families whose writers rotate: Rig's own records and the files launchd writes for a job. */
const rotates = (family: string) =>
  family === "target.jsonl" || wrapperLog.test(family);

/** The source `name` is, or undefined for a file that is not a Target log (such as a rotation lock). Rig's own records,
 * legacy events, launchd's legacy job log, the files launchd writes for a job, and each rotated generation of the
 * families that rotate. */
export function logSource(name: string): LogSource | undefined {
  if (
    name === "target.jsonl" ||
    name === "events.jsonl" ||
    launchdLog.test(name) ||
    wrapperLog.test(name)
  )
    return { name, family: name, generation: 0 };
  const generation = rotated.exec(name);
  if (generation && rotates(generation[1]!))
    return {
      name,
      family: generation[1]!,
      generation: Number(generation[2]),
    };
  return undefined;
}

/** Groups sources by family, each family oldest generation first so its files read in the order they were written.
 * Families come in name order. */
export function logFamilies(
  sources: readonly LogSource[],
): { family: string; members: LogSource[] }[] {
  const families = new Map<string, LogSource[]>();
  for (const source of sources)
    families.set(source.family, [
      ...(families.get(source.family) ?? []),
      source,
    ]);
  return [...families.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, members]) => ({
      family,
      members: members.sort((a, b) => b.generation - a.generation),
    }));
}

/** The component and stream every line of a family's files belongs to when its files are plain text launchd wrote;
 * undefined for families of records that name their own. */
export function familyEvidence(family: string): FamilyEvidence | undefined {
  const wrapper = wrapperLog.exec(family);
  if (wrapper)
    return {
      component: wrapper[1]!,
      stream: wrapper[2] as "stdout" | "stderr",
    };
  const launchd = launchdLog.exec(family);
  if (launchd) return { component: launchd[1]!, stream: "unknown" };
  return undefined;
}
