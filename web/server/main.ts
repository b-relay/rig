import landing from "../site/index.html";
import dashboard from "../dashboard/index.html";
import { liveDaemonAddress } from "../../src/daemon/connection";
import { rigRoot } from "../../src/cli/entry-environment";
import { RigError } from "../../src/domain/errors";
import { accessPolicy, admit, parseTrustedClients } from "./guard";
import { createRelay, RELAYED, type RelayedPath } from "./relay";
import { sandboxDaemon } from "./sandbox";
import { join } from "node:path";

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
if (sandboxRoot) {
  const daemon = sandboxDaemon(sandboxRoot, async (command, sandbox) => {
    const rigd = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../../src/rigd.ts"), command],
      {
        env: { ...process.env, RIG_ROOT: sandbox },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err] = await Promise.all([
      new Response(rigd.stdout).text(),
      new Response(rigd.stderr).text(),
    ]);
    return { exitCode: await rigd.exited, output: out + err };
  });
  await daemon.start();
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void daemon.stop().finally(() => process.exit(0));
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
