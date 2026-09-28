/** The rig.yaml formats Rig reads, the one it writes, and how each older one maps onto the next. See
 * docs/adr/0008-versioned-project-config-formats.md. */
import { rewriteReferences } from "./references";

export const CONFIG_FORMATS = ["rig/v1", "rig/v2"] as const;
export type ConfigFormat = (typeof CONFIG_FORMATS)[number];
/** The format `rig init`, `rig config upgrade` and recipes write, and the shape every parsed Project config has. */
export const LATEST_FORMAT = "rig/v2" as const satisfies ConfigFormat;
/** The format of a rig.yaml that declares none: every file written before formats existed. */
export const UNDECLARED_FORMAT = "rig/v1" as const satisfies ConfigFormat;

/** A Service setting that moved when the format changed: its path inside a Service before and after. */
export interface MovedSetting {
  readonly from: readonly [string];
  readonly to: readonly [string, string];
}
/** One format change: the format it leads from, the one it leads to, and the Service settings that moved. */
export interface FormatStep {
  readonly from: ConfigFormat;
  readonly to: ConfigFormat;
  readonly moves: readonly MovedSetting[];
}
/** Every format change, oldest first. rig/v2 moved start readiness into the `health` block (#309, #282). */
export const FORMAT_STEPS: readonly FormatStep[] = [
  {
    from: "rig/v1",
    to: "rig/v2",
    moves: [
      { from: ["ready"], to: ["health", "check"] },
      { from: ["ready_timeout"], to: ["health", "start_timeout"] },
    ],
  },
];

export function isConfigFormat(value: unknown): value is ConfigFormat {
  return (CONFIG_FORMATS as readonly unknown[]).includes(value);
}
/** Whether a file in `format` is older than the latest and should be upgraded. */
export function isDeprecatedFormat(format: ConfigFormat): boolean {
  return format !== LATEST_FORMAT;
}
/** The steps that take a file in `format` to the latest format, in order; none for the latest. */
export function stepsFrom(format: ConfigFormat): readonly FormatStep[] {
  const start = FORMAT_STEPS.findIndex((step) => step.from === format);
  return start === -1 ? [] : FORMAT_STEPS.slice(start);
}

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A reference key such as `services.web.ready` as the step spells it, or undefined when the step did not move it. */
export function movedReference(
  step: FormatStep,
  key: string,
): string | undefined {
  const match = /^services\.([^.]+)\.(.+)$/.exec(key);
  if (!match) return undefined;
  const move = step.moves.find((each) => each.from.join(".") === match[2]);
  return move && `services.${match[1]}.${move.to.join(".")}`;
}

/** Pure: a validated config value in `format` as the latest format spells it, `format` itself left out. Moved Service
 * settings go to their new place, in each Service and each role's Service patch, and every `${...}` reference to a moved
 * setting follows it. The input is not changed. */
export function upgradeConfigValue(
  value: Fields,
  format: ConfigFormat,
): Fields {
  let current: Fields = structuredClone(value);
  for (const step of stepsFrom(format)) current = applyStep(current, step);
  delete current.format;
  return current;
}
function applyStep(value: Fields, step: FormatStep): Fields {
  const moved = rewriteStrings(value, (text) =>
    rewriteReferences(text, (key) => movedReference(step, key)),
  ) as Fields;
  for (const service of serviceBlocks(moved)) {
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(service)) {
      const move = step.moves.find((each) => each.from[0] === key);
      if (!move) {
        entries.push([key, item]);
        continue;
      }
      // The block takes the place of the first setting moved into it.
      const [block, field] = move.to;
      let holder = entries.find(([name]) => name === block)?.[1] as
        Fields | undefined;
      if (!holder) {
        holder = {};
        entries.push([block, holder]);
      }
      holder[field] = item;
    }
    replaceEntries(service, entries);
  }
  return moved;
}
/** Rewrites a mapping in place with `entries`, in their order. */
function replaceEntries(record: Fields, entries: [string, unknown][]): void {
  for (const key of Object.keys(record)) delete record[key];
  for (const [key, item] of entries) record[key] = item;
}
/** Every Service mapping of a config value: each top-level Service and each role's Service patch. */
function serviceBlocks(value: Fields): Fields[] {
  return serviceBlockPaths(value).map(([, block]) => block);
}
/** Every Service mapping of a raw config value with its path: `services.<name>` and `targets.<role>.services.<name>`. */
export function serviceBlockPaths(value: unknown): [string[], Fields][] {
  const blocks: [string[], Fields][] = [];
  const collect = (services: unknown, at: string[]) => {
    if (isRecord(services))
      for (const [name, service] of Object.entries(services))
        if (isRecord(service)) blocks.push([[...at, name], service]);
  };
  if (!isRecord(value)) return blocks;
  collect(value.services, ["services"]);
  if (isRecord(value.targets))
    for (const [role, patch] of Object.entries(value.targets))
      if (isRecord(patch))
        collect(patch.services, ["targets", role, "services"]);
  return blocks;
}
function rewriteStrings(
  value: unknown,
  rewrite: (text: string) => string,
): unknown {
  if (typeof value === "string") return rewrite(value);
  if (Array.isArray(value))
    return value.map((item) => rewriteStrings(item, rewrite));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      rewriteStrings(item, rewrite),
    ]),
  );
}

/** Pure: a latest-format path inside a Service (`health.check`) as `format` spells it (`ready`); unchanged when the setting
 * did not move. Used to name a setting in the words of the file a user wrote. */
export function servicePathIn(
  format: ConfigFormat,
  path: readonly string[],
): string[] {
  let spelled = [...path];
  for (const step of [...stepsFrom(format)].reverse()) {
    const move = step.moves.find(
      (each) =>
        each.to.length <= spelled.length &&
        each.to.every((segment, index) => spelled[index] === segment),
    );
    if (move) spelled = [...move.from, ...spelled.slice(move.to.length)];
  }
  return spelled;
}
/** Pure: a Service as the latest format spells it, written the way `format` spells it; the inverse of the moves. Used to
 * print a bundled recipe into a Project that has not been upgraded yet. A block that keeps settings the older format has
 * no place for stays as it is, so validation names them. */
export function serviceIn(format: ConfigFormat, service: Fields): Fields {
  let current: Fields = structuredClone(service);
  for (const step of [...stepsFrom(format)].reverse()) {
    current = rewriteStrings(current, (text) =>
      rewriteReferences(text, (key) => {
        const match = /^services\.([^.]+)\.(.+)$/.exec(key);
        const move = match
          ? step.moves.find((each) => each.to.join(".") === match[2])
          : undefined;
        return move && `services.${match![1]}.${move.from.join(".")}`;
      }),
    ) as Fields;
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(current)) {
      const moves = step.moves.filter((each) => each.to[0] === key);
      if (!moves.length || !isRecord(item)) {
        entries.push([key, item]);
        continue;
      }
      const kept: Fields = { ...item };
      for (const move of moves)
        if (Object.hasOwn(kept, move.to[1])) {
          entries.push([move.from[0], kept[move.to[1]]]);
          delete kept[move.to[1]];
        }
      if (Object.keys(kept).length) entries.push([key, kept]);
    }
    replaceEntries(current, entries);
  }
  return current;
}
/** Pure: a Service as `format` spells it, written the way the latest format spells it. */
export function serviceFromFormat(
  format: ConfigFormat,
  service: Fields,
): Fields {
  return (
    upgradeConfigValue({ services: { entry: service } }, format)
      .services as Record<string, Fields>
  ).entry!;
}
