import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RigError } from "../domain/errors";
import { runCommand } from "./command-runner";
import type { CommandRunner } from "./contracts";
export interface RouteRequest {
  readonly key: string;
  readonly hostname: string;
  readonly upstream: string;
}
export interface RouteCheckpoint {
  readonly key: string;
  readonly value: string | null;
}
export interface Router {
  apply(route: RouteRequest): Promise<void>;
  remove(key: string): Promise<void>;
  checkpoint(key: string): Promise<RouteCheckpoint>;
  restore(saved: RouteCheckpoint, expected: RouteCheckpoint): Promise<void>;
}
/** Only marked Rig blocks are mutable; each change validates before publishing and rolls back on reload failure. */
export function createCaddyRouter(options: {
  readonly caddyfile: string;
  readonly run?: CommandRunner;
  readonly executable?: string;
  readonly reload?: boolean;
  readonly reloadCommand?: readonly string[];
  readonly extraConfig?: readonly string[];
}): Router {
  const run = options.run ?? runCommand;
  let pending: Promise<unknown> = Promise.resolve();
  async function change(
    key: string,
    route?: RouteRequest,
    restoration?: { saved: RouteCheckpoint; expected: RouteCheckpoint },
  ): Promise<void> {
    if (
      route &&
      (!/^(?:https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9.\-]*(?::\d{1,5})?$/.test(
        route.hostname,
      ) ||
        !/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(
          route.upstream,
        ))
    )
      throw new RigError(
        "ROUTE_INVALID",
        "The route address is invalid.",
        "Use a valid hostname and a localhost upstream.",
      );
    await mkdir(dirname(options.caddyfile), { recursive: true });
    const before = await readFile(options.caddyfile, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (
      restoration &&
      (restoration.saved.key !== key ||
        restoration.expected.key !== key ||
        ownedBlock(before, key) !== restoration.expected.value)
    )
      throw new RigError(
        "ROUTE_CHANGED",
        "The route changed after its checkpoint.",
        "Inspect the current route before retrying recovery.",
      );
    const existing = restoration
      ? restoration.expected.value
      : ownedBlock(before, key);
    const without = existing === null ? before : before.replace(existing, "");
    if (route && hostnamePresent(without, route.hostname))
      throw new RigError(
        "ROUTE_CONFLICT",
        "This hostname is already owned by another route.",
        "Choose a different hostname or explicitly migrate its existing owner.",
        { hostname: route.hostname },
      );
    const { begin, end } = routeMarkers(key);
    const block = restoration
      ? (restoration.saved.value ?? "")
      : route
        ? `${begin}\n${route.hostname} {\n  reverse_proxy ${route.upstream}\n${(options.extraConfig ?? []).map((line) => "  " + line + "\n").join("")}}\n${end}\n`
        : "";
    const after =
      without + (without && !without.endsWith("\n") ? "\n" : "") + block;
    if (after === before) return;
    const mode =
      (await stat(options.caddyfile).catch(() => undefined))?.mode ?? 0o600;
    const temporary = `${options.caddyfile}.${randomUUID()}.tmp`;
    const executable = options.executable ?? "caddy";
    const reloadCommand = options.reloadCommand ?? [
      executable,
      "reload",
      "--config",
      options.caddyfile,
      "--adapter",
      "caddyfile",
    ];
    try {
      await writeFile(temporary, after, { mode });
      const validation = await run({
        command: [
          executable,
          "validate",
          "--config",
          temporary,
          "--adapter",
          "caddyfile",
        ],
      });
      if (validation.exitCode !== 0)
        throw new RigError(
          "ROUTE_VALIDATE",
          "Caddy rejected the updated routes.",
          "Inspect the route configuration and retry.",
          { stderr: validation.stderr },
        );
      await writeFile(`${options.caddyfile}.rig-backup`, before, { mode });
      await rename(temporary, options.caddyfile);
      if (options.reload !== false) {
        const reload = await run({
          command: reloadCommand,
        }).catch((error) => ({
          exitCode: 1,
          stdout: "",
          stderr: String(error),
        }));
        if (reload.exitCode !== 0) {
          await writeFile(temporary, before, { mode });
          await rename(temporary, options.caddyfile);
          const rollback = await run({
            command: reloadCommand,
          }).catch(() => ({ exitCode: 1 }));
          throw new RigError(
            "ROUTE_RELOAD",
            "Caddy could not reload; the previous configuration was restored.",
            rollback.exitCode
              ? "The rollback reload also failed. Inspect Caddy before retrying."
              : "Inspect Caddy diagnostics and retry.",
            {
              rollbackReloaded: rollback.exitCode === 0,
              stderr: reload.stderr,
            },
          );
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  function serialized(key: string, route?: RouteRequest): Promise<void> {
    const operation = pending.catch(() => {}).then(() => change(key, route));
    pending = operation;
    return operation;
  }
  return {
    apply: (route) => serialized(route.key, route),
    remove: (key) => serialized(key),
    async checkpoint(key) {
      await pending.catch(() => {});
      const text = await readFile(options.caddyfile, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return { key, value: ownedBlock(text, key) };
    },
    restore(saved, expected) {
      const operation = pending
        .catch(() => {})
        .then(() => change(saved.key, undefined, { saved, expected }));
      pending = operation;
      return operation;
    },
  };
}
function hostnamePresent(text: string, hostname: string): boolean {
  const canonical = hostname.replace(/^https?:\/\//, "").toLowerCase();
  return text.split("\n").some((line) => {
    const header = line.trim().replace(/\s*#.*$/, "");
    if (!header.endsWith("{")) return false;
    return header
      .slice(0, -1)
      .split(/[\s,]+/)
      .some(
        (address) =>
          address.replace(/^https?:\/\//, "").toLowerCase() === canonical,
      );
  });
}

function routeMarkers(key: string): { begin: string; end: string } {
  const token = createHash("sha256").update(key).digest("hex");
  return { begin: `# rig begin ${token}`, end: `# rig end ${token}` };
}

/** Reads the complete owned block, including its newline, or rejects incomplete markers. */
function ownedBlock(text: string, key: string): string | null {
  const { begin, end } = routeMarkers(key);
  const start = text.indexOf(begin),
    finish = text.indexOf(end);
  if (start >= 0 !== finish >= 0 || (start >= 0 && finish < start))
    throw new RigError(
      "ROUTE_CORRUPT",
      "A managed route marker is incomplete.",
      "Repair the Caddyfile before changing routes.",
    );
  if (start < 0) return null;
  const endPosition = finish + end.length;
  return (
    text.slice(start, endPosition) +
    (text.slice(endPosition).startsWith("\r\n")
      ? "\r\n"
      : text[endPosition] === "\n"
        ? "\n"
        : "")
  );
}
