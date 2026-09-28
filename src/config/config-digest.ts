import { createHash } from "node:crypto";
import type { ProjectConfig } from "./types";

/** Pure: a SHA-256 of what a parsed Project config says, with every mapping's keys in order. It ignores how the file spells
 * it: its format, comments, key order and layout. Two files that parse to the same config share it. */
export function configDigest(config: ProjectConfig): string {
  return createHash("sha256").update(canonical(config)).digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .filter((key) => fields[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
