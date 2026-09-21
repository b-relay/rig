import landing from "../site/index.html";
import dashboard from "../dashboard/index.html";
import { DaemonClient } from "../../src/daemon/client";
import type { ListResult } from "../../src/daemon/protocol";
import { liveDaemonAddress } from "../../src/daemon/connection";
import { rigRoot } from "../../src/cli/entry-environment";
import { RigError } from "../../src/domain/errors";
import { accessPolicy, admit, parseTrustedClients } from "./guard";
import { createRelay, RELAYED, type RelayedPath } from "./relay";
import { sandboxDaemon } from "./sandbox";
import { downCommands, seedSandbox } from "./seed";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Effect owner for the Rig website: the landing page, the dashboard, and the relay to this Host's rigd. */
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0)
  throw new RigError(
    "WEB_PORT_MISSING",
    "PORT does not name a localhost port to serve on.",
    "Run it as a Rig Service, or set PORT, for example PORT=4173.",
    { port: process.env.PORT },
  );
// A Preview names a sandbox root: the site then runs a throwaway rigd there and relays to it, never to the Host's.
const sandboxRoot = process.env.RIG_WEB_SANDBOX_ROOT;
const root = sandboxRoot ?? rigRoot();
const policy = accessPolicy({
  port,
  ...(process.env.RIG_WEB_HOST ? { publicHost: process.env.RIG_WEB_HOST } : {}),
  ...(process.env.RIG_WEB_DASHBOARD_HOST
    ? { dashboardHost: process.env.RIG_WEB_DASHBOARD_HOST }
    : {}),
  sandboxed: sandboxRoot !== undefined,
  trustedClients: parseTrustedClients(
    process.env.RIG_WEB_TRUSTED_CLIENTS ?? "",
  ),
});
const relay = createRelay({
  address: () => liveDaemonAddress(root),
  send: (url, init) => fetch(url, init),
});
/** Runs one command to completion and answers with its exit code and everything it printed. */
async function execute(
  argv: string[],
  env: Record<string, string | undefined>,
) {
  const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout: out, output: out + err };
}
if (sandboxRoot) {
  const source = (entry: string) => join(import.meta.dir, "../../src", entry);
  const env = { ...process.env, RIG_ROOT: sandboxRoot };
  const rig = (args: string[]) =>
    execute([process.execPath, source("index.ts"), ...args], env);
  const daemon = sandboxDaemon(sandboxRoot, (command) =>
    execute([process.execPath, source("rigd.ts"), command], env),
  );
  await daemon.start();
  // Demo Projects live beside the sandbox root, in the same Preview data directory.
  const projectsRoot = join(dirname(sandboxRoot), "demo-projects");
  await mkdir(projectsRoot, { recursive: true });
  // Seeding deploys, which takes a while; the site serves meanwhile and the Projects appear as they land.
  void seedSandbox(join(import.meta.dir, "../demo"), projectsRoot, {
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
      process.stderr.write(
        `demo Project ${failure.project} was not seeded: ${failure.cause}\n`,
      );
  });
  // The Host's rigd allows a stopping Service four seconds, so this talks to the sandbox's
  // control plane directly and stops every Project at once rather than starting a CLI per step.
  const stopTargets = async () => {
    const control = new DaemonClient(await liveDaemonAddress(sandboxRoot));
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
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void stopTargets()
        .catch(() => {})
        .then(() => daemon.stop())
        .finally(() => process.exit(0));
    });
}
const isRelayed = (path: string): path is RelayedPath =>
  Object.hasOwn(RELAYED, path);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  development: false,
  maxRequestBodySize: 1024 * 1024,
  idleTimeout: 30,
  routes: {
    "/": landing,
    "/dashboard": dashboard,
    "/healthz": new Response("ok"),
  },
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (!isRelayed(path) || request.method !== RELAYED[path].method)
      return new Response("Not found", { status: 404 });
    const admission = admit(request, policy);
    if (!admission.admitted)
      return Response.json(
        { error: { code: admission.code, message: admission.message } },
        { status: admission.status },
      );
    // Deploys legitimately run for minutes; rigd owns their budgets.
    server.timeout(request, 0);
    return relay(
      path,
      request.method === "POST" ? await request.text() : undefined,
      request.signal,
    );
  },
});
