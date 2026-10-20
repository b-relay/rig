/** A system rigd (`daemon.start: boot`) for administration tests: the real composition as launchd's system job runs it, with
 * Rig's Caddy as a detached process instead of a system job, since a test defines no launchd job. While
 * `<RIG_ROOT>/refuse-caddy-restart` exists, a restart of Caddy is refused before it stops anything, as a job manager that
 * cannot act refuses it. Started as the job's program is, with RIG_ROOT set. */
import { mock } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as caddyJob from "../../src/providers/caddy-job";
import { RigError } from "../../src/domain/errors";

const root = process.env.RIG_ROOT!;
const original = { ...caddyJob };
mock.module(join(import.meta.dir, "../../src/providers/caddy-job.ts"), () => ({
  ...original,
  createCaddyJob: (options: Parameters<typeof original.createCaddyJob>[0]) => {
    const job = original.createCaddyJob({ ...options, mode: "process" });
    return {
      ...job,
      async restart() {
        if (existsSync(join(root, "refuse-caddy-restart")))
          throw new RigError(
            "PROXY_START",
            "Rig's Caddy was not restarted: its job refused.",
            "Retry once the job can be restarted.",
          );
        await job.restart();
      },
    };
  },
}));
const { composeDaemon } = await import("../../src/daemon/composition");
const { runDaemonHost } = await import("../../src/daemon/host");
const runtime = await composeDaemon(
  root,
  [process.execPath, join(import.meta.dir, "../../src/rigd.ts"), "capture"],
  undefined,
  "system",
);
await runDaemonHost({ root, port: 0, ...runtime });
