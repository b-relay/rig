import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ConfigError } from "./errors";
import type { HostConfig } from "./types";

const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** The `diagnostics` section of the Host config in config.yaml under `stateRoot`, parsed and validated as `readHostConfig`
 * reads the whole document, so it fails where that does, but without the Project schema or the config editor. Undefined,
 * so the section's defaults apply, when the document cannot set it: there is no config.yaml, or its text holds neither the
 * word `diagnostics` nor a backslash, the only escape that could spell it. Valid or not, such a document leaves the defaults,
 * so the YAML parser and the Host schema load only for one that might set the section. */
export async function readHostDiagnostics(
  stateRoot: string,
): Promise<HostConfig["diagnostics"] | undefined> {
  const path = join(resolve(stateRoot), "config.yaml");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) return undefined;
    throw new ConfigError(
      "Unable to read config document.",
      "read_failed",
      { path },
      `Make ${path} a file you can read, then retry.`,
    );
  }
  if (!raw.includes("diagnostics") && !raw.includes("\\")) return undefined;
  const [{ yamlValue }, { checkedHostConfigSchema }] = await Promise.all([
    import("./yaml-document"),
    import("./host-schema"),
  ]);
  const host = checkedHostConfigSchema.safeParse(yamlValue(raw, path));
  if (!host.success)
    throw new ConfigError(
      "Invalid Host configuration.",
      "invalid_config",
      { path },
      `Fix the Host config fields rigd names when it reads ${path}; until then the diagnostic log keeps its default level and retention.`,
    );
  return host.data.diagnostics;
}
