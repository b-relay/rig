import type { ProxyMode } from "../config/proxy-schema";
import type { DaemonMode, InstallationRecord } from "./installation";

/** Whether `recorded` names the installation an install would make now: the same mode, build, command, bun and proxy mode
 * (external when absent). The daemon reads the recorded bun and chooses its router at startup, so a different one needs a
 * restart to take effect. */
export function recordedAsWanted(
  recorded: InstallationRecord,
  wanted: {
    mode: DaemonMode;
    command: readonly string[];
    version: string;
    bun: string | undefined;
    proxy: ProxyMode | undefined;
  },
): boolean {
  return (
    recorded.mode === wanted.mode &&
    recorded.version === wanted.version &&
    (recorded.command ?? []).join("\0") === wanted.command.join("\0") &&
    recorded.bun === wanted.bun &&
    (recorded.proxy ?? "external") === (wanted.proxy ?? "external")
  );
}
