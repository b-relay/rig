import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DaemonClient } from "../../src/daemon/client";
import type { ListResult } from "../../src/daemon/protocol";
import { daemonAddress } from "./daemon";
import { sandboxDaemon } from "./sandbox";
import { downCommands, seedSandbox } from "./seed";
import type { SiteSettings } from "./site";
import { sitePolicy } from "./site";

/** Runs one command to completion and answers with its exit code and everything it printed. */
function execute(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const [command, ...args] = argv as [string, ...string[]];
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error: Error) =>
      resolve({ exitCode: 127, output: error.message }),
    );
    child.on("close", (code: number | null) =>
      resolve({ exitCode: code ?? 1, output }),
    );
  });
}
/** Effect owner for the site's life beside Next: the access key file, and for a Preview the
 * sandbox rigd with its demo Projects. The site owns its shutdown too (`NEXT_MANUAL_SIG_HANDLE`),
 * so a stopping sandbox gets its Targets stopped before the process ends. */
export async function startSite(settings: SiteSettings): Promise<void> {
  // The Service's log is its stdout; rigd keeps it.
  const log = (line: string) => process.stdout.write(`${line}\n`);
  await sitePolicy();
  if (settings.keyFile)
    log(
      `Clients beyond this Mac sign in with the access key in ${settings.keyFile}`,
    );
  const sandboxRoot = settings.sandboxRoot;
  let stopSandbox = async () => {};
  if (sandboxRoot) {
    const source = (entry: string) => join(settings.repository, "src", entry);
    const env = { ...process.env, RIG_ROOT: sandboxRoot };
    // The sandbox's rig and rigd run from this repository's sources, under the Bun that runs the site.
    const rig = (args: string[]) =>
      execute(["bun", source("index.ts"), ...args], env);
    const daemon = sandboxDaemon(sandboxRoot, (command) =>
      execute(["bun", source("rigd.ts"), command], env),
    );
    await daemon.start();
    // Demo Projects live beside the sandbox root, in the same Preview data directory.
    const projectsRoot = join(dirname(sandboxRoot), "demo-projects");
    await mkdir(projectsRoot, { recursive: true });
    // Seeding deploys, which takes a while; the site serves meanwhile and the Projects appear as they land.
    void seedSandbox(join(settings.repository, "web", "demo"), projectsRoot, {
      exists: (path) =>
        stat(path).then(
          () => true,
          () => false,
        ),
      run: async (step) => {
        const done =
          step.kind === "rig"
            ? await rig(step.args)
            : await execute(step.argv, env);
        if (done.exitCode !== 0) throw new Error(done.output.trim());
      },
    }).then((failures) => {
      for (const failure of failures)
        log(`demo Project ${failure.project} was not seeded: ${failure.cause}`);
    });
    // The Host's rigd allows a stopping Service four seconds, so this talks to the sandbox's
    // control plane directly and stops every Project at once rather than starting a CLI per step.
    stopSandbox = async () => {
      const control = new DaemonClient(await daemonAddress(sandboxRoot));
      const { projects } = (await control.command({
        action: "list",
      })) as ListResult;
      await Promise.all(
        projects.map(async ({ name }) => {
          const { targets } = await control.status({ project: name });
          for (const down of downCommands(name, targets))
            await control.command(down);
        }),
      );
      await daemon.stop();
    };
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void stopSandbox()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
}
