/** A rigd's managed Caddy about to route the dashboard's domain to `<port>`, run as its own process so a test can kill it
 * mid-publication: `bun caddy-crash-publisher.ts <root> <settings JSON> <port>`. Whatever would make Caddy take a
 * configuration (a Caddy command that writes to it, or a load through its admin API) is held before it submits anything,
 * after writing `<root>/held`, until `<root>/resume` exists. A held Caddy command runs as a process of its own, through
 * the real command runner, as managed Caddy's commands do. */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCaddyAdmin } from "../../src/providers/caddy-admin";
import { createManagedCaddy } from "../../src/providers/managed-caddy";
import { runCommand } from "../../src/providers/command-runner";
import { proxyPaths } from "../../src/domain/managed-proxy";
import type { ProxySettings } from "../../src/config/proxy-schema";

const [root, settingsJson, port] = process.argv.slice(2) as [
  string,
  string,
  string,
];
const settings = JSON.parse(settingsJson) as ProxySettings;
const held = join(root, "held");
const resume = join(root, "resume");
const admin = createCaddyAdmin(proxyPaths(root).socket);
const route = { domain: "rig.example.test", port: Number(port) };
const caddy = createManagedCaddy({
  root,
  settings: async () => settings,
  dashboard: { current: () => route, confirmed: async () => route },
  job: { state: async () => "running", restart: async () => {} },
  admin: {
    ...admin,
    async load(config, signal) {
      await writeFile(held, "load");
      while (!existsSync(resume)) await Bun.sleep(20);
      return admin.load(config, signal);
    },
  },
  run: (request) =>
    request.command[1] === "reload"
      ? runCommand({
          ...request,
          command: [
            "/bin/sh",
            "-c",
            // Its output goes nowhere, so it outlives the closed pipes of a killed rigd, as a quiet command would.
            'echo command > "$1"; exec >/dev/null 2>&1; while [ ! -e "$2" ]; do /bin/sleep 0.05; done; shift 2; exec "$@"',
            "held",
            held,
            resume,
            ...request.command,
          ],
        })
      : runCommand(request),
});
await caddy.refreshDashboard();
