import type { HostConfig } from "../config/types";
import type { OperatorAlerts } from "../domain/operator-alerts";
import type { CommandRunner } from "../providers/contracts";
import { createMacosNotifications } from "../providers/macos-notification";

/** The channels operator alerts go out on, from the Host config and how rigd was installed. The macOS notification is on by
 * default only for a rigd installed as a LaunchAgent: a process-mode rigd runs under RIG_ROOT for tests and agent runs, and
 * posts nothing to the user's screen unless its Host config turns the channel on. */
export function alertChannels(
  config: HostConfig["alerts"],
  mode: "process" | "launchd",
  run: CommandRunner,
): OperatorAlerts[] {
  const macos = config.channels.macos.enabled ?? mode === "launchd";
  return macos ? [createMacosNotifications({ run })] : [];
}
