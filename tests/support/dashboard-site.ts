import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionValue } from "../../web/server/guard";
import { site } from "../../web/server/site";

/** The one dashboard site a test process drives. The site reads its environment once, on first use, and test files
 * share a process, so every file that drives it imports this first: the same port, published name, trusted range and
 * access key, under a temporary Rig root with no rigd, so nothing reaches the user's own. */
const root = mkdtempSync(join(tmpdir(), "rig-dashboard-site-"));
export const SITE = {
  port: 48173,
  root,
  keyFile: join(root, "auth", "dashboard.key"),
  key: "test-access-key-".padEnd(43, "k"),
  host: "rig.example.test",
  trusted: "100.64.0.0/10",
} as const;
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "auth"), { recursive: true, mode: 0o700 });
writeFileSync(SITE.keyFile, `${SITE.key}\n`, { mode: 0o600 });
/** Every variable the site reads its settings from, as this site has it: undefined is unset, whatever the test process
 * inherited. */
const environment: Record<string, string | undefined> = {
  PORT: String(SITE.port),
  RIG_ROOT: root,
  RIG_WEB_KEY_FILE: SITE.keyFile,
  RIG_WEB_HOST: SITE.host,
  RIG_WEB_TRUSTED_CLIENTS: SITE.trusted,
  RIG_WEB_DASHBOARD_HOST: undefined,
  RIG_WEB_SANDBOX_ROOT: undefined,
  RIG_WEB_REPOSITORY: undefined,
};
const set = (values: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(values))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
};
const previous = Object.fromEntries(
  Object.keys(environment).map((name) => [name, process.env[name]]),
);
// Read now, while the environment names this site alone, then put the environment back for every other test.
set(environment);
site();
set(previous);

/** A Cookie header holding a session this site signed, valid for an hour. */
export const session = (): string =>
  `rig_session=${sessionValue(SITE.key, Math.floor(Date.now() / 1000) + 3600)}`;
/** An Authorization header presenting the key, as a browser answers the loopback address's challenge. */
export const basic = (password: string = SITE.key): string =>
  `Basic ${Buffer.from(`rig:${password}`).toString("base64")}`;
/** Headers a page on this Mac sends, addressed to the site's loopback port: no X-Forwarded-For. */
export const local = (): Record<string, string> => ({
  host: `127.0.0.1:${SITE.port}`,
  origin: `http://127.0.0.1:${SITE.port}`,
  "sec-fetch-site": "same-origin",
});
/** Headers a page sends through Rig's Caddy, which names the client it saw in X-Forwarded-For. */
export const throughCaddy = (client: string): Record<string, string> => ({
  host: SITE.host,
  origin: `https://${SITE.host}`,
  "sec-fetch-site": "same-origin",
  "x-forwarded-for": client,
});
