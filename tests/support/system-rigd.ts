/** A system rigd (`daemon.start: boot`) for administration tests: the real composition as launchd's system job runs it, with
 * Rig's Caddy as a detached process instead of a system job, since a test defines no launchd job. Started as the job's
 * program is, with RIG_ROOT set. */
import { mock } from "bun:test";
import { join } from "node:path";
import * as caddyJob from "../../src/providers/caddy-job";

const original = { ...caddyJob };
mock.module(join(import.meta.dir, "../../src/providers/caddy-job.ts"), () => ({
  ...original,
  createCaddyJob: (options: Parameters<typeof original.createCaddyJob>[0]) =>
    original.createCaddyJob({ ...options, mode: "process" }),
}));
const { composeDaemon } = await import("../../src/daemon/composition");
const { runDaemonHost } = await import("../../src/daemon/host");
const root = process.env.RIG_ROOT!;
const runtime = await composeDaemon(
  root,
  [process.execPath, join(import.meta.dir, "../../src/rigd.ts"), "capture"],
  undefined,
  "system",
);
await runDaemonHost({ root, port: 0, ...runtime });
