import { createHash } from "node:crypto";
import type { ProjectConfig } from "./types";

/** Pure: a SHA-256 of what a parsed Project config says. It ignores how the file spells it (its format, comments and
 * layout, and the order of a Service's own settings, which the parser gives in one order), but not the order of entries in
 * a map such as `services`, which decides the order Rig starts them in. Two files that parse to the same config share it. */
export function configDigest(config: ProjectConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
