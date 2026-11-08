import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RigError } from "../domain/errors";
import type { DaemonLauncher } from "./admin-launcher";

export type LaunchctlRunner = (
  args: readonly string[],
) => Promise<{ code: number; stderr: string }>;
/** Runs /bin/launchctl with `args`. */
export async function runLaunchctl(
  args: readonly string[],
): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn(["/bin/launchctl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stderr };
}
/** The launchd label of the rigd of `root`, as a LaunchAgent and as a system job. */
export function rigdJobLabel(root: string): string {
  return `com.b-relay.rigd.${Bun.hash(root).toString(16)}`;
}
export function launchctlFailure(result: {
  code: number;
  stderr: string;
}): RigError {
  const reason = result.stderr.trim().split("\n").filter(Boolean).at(-1);
  return new RigError(
    "LAUNCHD",
    reason
      ? `Unable to administer the rigd launchd job: ${reason}`
      : "Unable to administer the rigd launchd job.",
    "Inspect daemon installation and retry.",
    { code: result.code, stderr: result.stderr },
  );
}
const xml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
/** The plist of rigd's LaunchAgent: started at login and again after any unsuccessful exit, its output appended to the
 * daemon's startup log. */
export function launchAgentPlist(job: {
  label: string;
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  root: string;
}): string {
  const log = join(job.root, "daemon", "startup.log");
  return `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${xml(job.label)}</string><key>ProgramArguments</key><array>${job.command.map((v) => `<string>${xml(v)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict>${Object.entries(
    job.environment,
  )
    .map(
      ([name, value]) =>
        `<key>${xml(name)}</key><string>${xml(value)}</string>`,
    )
    .join(
      "",
    )}</dict><key>WorkingDirectory</key><string>${xml(job.root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>`;
}
/** rigd as a LaunchAgent in the login of `uid` (the current user when absent): defined in `userHome`'s LaunchAgents and
 * administered through `launchctl`. `environment` is read as the job is defined. */
export function createLaunchAgent(options: {
  root: string;
  command: readonly string[];
  userHome: string;
  uid: number | undefined;
  launchctl: LaunchctlRunner;
  environment: () => Record<string, string>;
}): DaemonLauncher {
  const label = rigdJobLabel(options.root);
  const domain = () => `gui/${options.uid ?? process.getuid?.() ?? 501}`;
  const service = () => `${domain()}/${label}`;
  const agents = join(options.userHome, "Library", "LaunchAgents");
  const plistPath = join(agents, `${label}.plist`);
  const launchctl = async (args: string[]) => {
    const result = await options.launchctl(args);
    if (result.code !== 0) throw launchctlFailure(result);
  };
  return {
    async start() {
      await mkdir(agents, { recursive: true });
      const plist = launchAgentPlist({
        label,
        command: options.command,
        environment: options.environment(),
        root: options.root,
      });
      await writeFile(plistPath, plist, { mode: 0o600 });
      await launchctl(["bootout", service()]).catch(() => {});
      await launchctl(["bootstrap", domain(), plistPath]);
    },
    stop: () => launchctl(["bootout", service()]),
    async stopUnreachable() {
      const result = await options.launchctl(["bootout", service()]);
      if (
        result.code !== 0 &&
        !/No such process|Could not find/i.test(result.stderr)
      )
        throw launchctlFailure(result);
    },
    abandon: () => launchctl(["bootout", service()]).catch(() => {}),
    discard: () => rm(plistPath, { force: true }),
  };
}
