/** A system rigd (`daemon.start: boot`) for administration tests: the real composition as launchd's system job runs it, with
 * Rig's Caddy as a detached process instead of a system job, since a test defines no launchd job. While
 * `<RIG_ROOT>/refuse-caddy-restart` exists, a restart of Caddy is refused before it stops anything, as a job manager that
 * cannot act refuses it; while `<RIG_ROOT>/hold-caddy-restart` exists, a restart waits for its new process to answer, up
 * to 30 s or until it is cancelled, writing `<RIG_ROOT>/caddy-restart-held` as it begins. Started as the job's program is,
 * with RIG_ROOT set. */
import { mock } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as caddyJob from "../../src/providers/caddy-job";
import { RigError } from "../../src/domain/errors";

const root = process.env.RIG_ROOT!;
const original = { ...caddyJob };
mock.module(join(import.meta.dir, "../../src/providers/caddy-job.ts"), () => ({
  ...original,
  createCaddyJob: (options: Parameters<typeof original.createCaddyJob>[0]) => {
    // While `<RIG_ROOT>/ignore-caddy-stop` exists, the job's request that Caddy stop goes unheeded (its admin API answers
    // nothing), so a restart waits for the old process to exit; `<RIG_ROOT>/caddy-stop-ignored` is written as it does.
    const job = original.createCaddyJob({
      ...options,
      mode: "process",
      admin: {
        ...options.admin,
        async stop() {
          if (!existsSync(join(root, "ignore-caddy-stop")))
            return options.admin.stop();
          await writeFile(join(root, "caddy-stop-ignored"), "");
          return false;
        },
      },
    });
    return {
      ...job,
      async restart(signal?: AbortSignal) {
        if (existsSync(join(root, "refuse-caddy-restart")))
          throw new RigError(
            "PROXY_START",
            "Rig's Caddy was not restarted: its job refused.",
            "Retry once the job can be restarted.",
          );
        // As a job whose new process takes its whole deadline to answer: waits while the file exists, up to 30 s.
        const hold = join(root, "hold-caddy-restart");
        if (existsSync(hold)) {
          await writeFile(join(root, "caddy-restart-held"), "");
          for (
            const deadline = Date.now() + 30_000;
            existsSync(hold) && !signal?.aborted && Date.now() < deadline;
          )
            await Bun.sleep(50);
          if (signal?.aborted)
            throw new RigError(
              "PROXY_START",
              "The restart of Rig's Caddy was cancelled before it answered.",
              "Rig's Caddy may still be starting.",
            );
        }
        await job.restart(signal);
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
