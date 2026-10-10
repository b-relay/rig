/** A launchd job Rig defines: a LaunchAgent in the user's login, or a system job that runs as the user (ADR 0014). */
export interface LaunchdJob {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  /** Where the job's stdout and stderr go. */
  readonly log: string;
  /** `always` restarts the program whenever it exits; `failure` only when it exits unsuccessfully. */
  readonly keepAlive: "always" | "failure";
  /** Set for a system job: the account it runs as, never root. */
  readonly userName?: string;
  readonly groupName?: string;
}
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const entry = (key: string, value: string) =>
  `  <key>${xml(key)}</key>\n  ${value}\n`;
const string = (value: string) => `<string>${xml(value)}</string>`;
/** The plist text for `job`. Pure: the same job renders the same text, so an installed plist can be compared byte for byte. */
export function renderLaunchdPlist(job: LaunchdJob): string {
  if (job.userName === "root")
    throw new Error("Rig never defines a launchd job that runs as root.");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    entry("Label", string(job.label)) +
    (job.userName ? entry("UserName", string(job.userName)) : "") +
    (job.groupName ? entry("GroupName", string(job.groupName)) : "") +
    entry(
      "ProgramArguments",
      `<array>${job.programArguments.map(string).join("")}</array>`,
    ) +
    entry(
      "EnvironmentVariables",
      `<dict>${Object.entries(job.environment)
        .map(([name, value]) => `<key>${xml(name)}</key>${string(value)}`)
        .join("")}</dict>`,
    ) +
    entry("WorkingDirectory", string(job.workingDirectory)) +
    entry("RunAtLoad", "<true/>") +
    entry(
      "KeepAlive",
      job.keepAlive === "always"
        ? "<true/>"
        : "<dict><key>SuccessfulExit</key><false/></dict>",
    ) +
    entry("ThrottleInterval", "<integer>10</integer>") +
    entry("Umask", "<integer>63</integer>") +
    entry("StandardOutPath", string(job.log)) +
    entry("StandardErrorPath", string(job.log)) +
    "</dict>\n</plist>\n"
  );
}
