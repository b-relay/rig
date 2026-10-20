/** A rigd for administration tests: the real daemon host, serving the real dashboard supervisor published through the
 * scripted Rig's Caddy. Caddy's admin socket stops answering while `<RIG_ROOT>/caddy-unreachable` exists, and every
 * configuration Caddy loads appends what it does with the dashboard's domain to `<RIG_ROOT>/caddy-loads`. While
 * `<RIG_ROOT>/caddy-hold` exists, Caddy's admin API holds its answers, so every publication waits, until rigd shuts down
 * (as a real admin request or provider command ends at its own deadline, never keeping rigd from exiting). The dashboard's
 * port is the number in `<RIG_ROOT>/dashboard-port`. */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runDaemonHost } from "../../src/daemon/host";
import {
  dashboardDirectory,
  openDashboard,
  type Dashboard,
} from "../../src/daemon/dashboard";
import { createListenerInspection } from "../../src/providers/listener-inspection";
import { runCommand } from "../../src/providers/command-runner";
import { waitForLogPoll } from "../../src/adapters/log-follow-scheduler";
import { DEFAULT_LOG_RETENTION } from "../../src/domain/log-retention";
import { TOKEN, hostAnswer, managedCaddyWorld } from "./managed-caddy-double";

const DASHBOARD_DOMAIN = "rig.example.test";
const root = process.env.RIG_ROOT!;
let dashboard: Dashboard | undefined;
const caddy = await managedCaddyWorld({}, TOKEN, {
  current: () => dashboard?.route(),
  confirmed: async () => dashboard?.confirmedRoute(),
});
caddy.control.onLoad = async (config) => {
  await appendFile(
    join(root, "caddy-loads"),
    `${hostAnswer(config, DASHBOARD_DOMAIN) ?? "none"}\n`,
  );
};
const unreachable = join(root, "caddy-unreachable");
const hold = join(root, "caddy-hold");
let exiting = false;
caddy.control.beforeConfig = async () => {
  while (existsSync(hold) && !exiting) await Bun.sleep(20);
};
Object.defineProperty(caddy.control, "reachable", {
  get: () => !existsSync(unreachable),
});
const directory = dashboardDirectory(root);
await mkdir(join(directory, "web"), { recursive: true });
await writeFile(
  join(directory, "web", "server.js"),
  `Bun.serve({ port: Number(process.env.PORT), hostname: process.env.HOSTNAME, fetch: () => new Response(String(process.pid)) });`,
);
const opened = (await openDashboard({
  root,
  port: Number(await readFile(join(root, "dashboard-port"), "utf8")),
  directory,
  executable: process.execPath,
  published: {
    domain: DASHBOARD_DOMAIN,
    authority: DASHBOARD_DOMAIN,
    trustedClients: [],
  },
  retention: async () => DEFAULT_LOG_RETENTION,
  notices: { note: () => {}, clear: () => {} },
  listeners: createListenerInspection(runCommand),
  publish: async () => void (await caddy.caddy.refreshDashboard()),
  stopConfirmMs: 1500,
  wait: waitForLogPoll,
  now: Date.now,
}))!;
dashboard = opened;
// Queued, as rigd queues it at its start: it never delays rigd answering.
void caddy.caddy.republish().catch(() => {});
opened.start();
await runDaemonHost({
  root,
  port: 0,
  handle: async () => ({ ready: true }),
  dashboard: () => (opened.stopped() ? undefined : opened.serving),
  dashboardProblem: () => opened.problem(),
  prepareStop: () => opened.stop(),
  shutdown: async () => {
    exiting = true;
    await opened.stop();
    await rm(caddy.root, { recursive: true, force: true });
  },
});
