import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { RigError, boundedEvidence, lastOutputLine } from "../domain/errors";
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
  /** Runs caddy validate and the reload command; the daemon passes the platform runner, a test a fake. */
  readonly run: CommandRunner;
  readonly executable?: string;
  readonly reload?: boolean;
  readonly reloadCommand?: readonly string[];
  readonly extraConfig?: readonly string[];
}): Router {
  const { run } = options;
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
    // Nothing owned to remove and nothing to add leaves the file, and Caddy, untouched.
    if (!block && existing === null) return;
    const after =
      without + (without && !without.endsWith("\n") ? "\n" : "") + block;
    if (after === before) return;
    // Write through a symlinked Caddyfile so the file Caddy reads changes and the link survives.
    const file = await realpath(options.caddyfile).catch(
      () => options.caddyfile,
    );
    const mode = (await stat(file).catch(() => undefined))?.mode ?? 0o600;
    const temporary = `${file}.${randomUUID()}.tmp`;
    const executable = options.executable ?? "caddy";
    const reloadCommand = options.reloadCommand ?? [
      executable,
      "reload",
      "--config",
      options.caddyfile,
      "--adapter",
      "caddyfile",
    ];
    const rejected = `${file}.rejected`;
    try {
      await writeFile(temporary, after, { mode });
      const validation = await runCaddy([
        executable,
        "validate",
        "--config",
        temporary,
        "--adapter",
        "caddyfile",
      ]);
      if (validation.exitCode !== 0) {
        // The rejected text is kept where the hint names it so the user can read what Caddy saw.
        await rename(temporary, rejected);
        const reason = lastOutputLine(validation.stderr);
        throw new RigError(
          "ROUTE_VALIDATE",
          `Caddy rejected the updated routes${reason ? `: ${reason}` : "."}`,
          `The rejected configuration is kept at ${rejected}; fix the route configuration and retry.`,
          {
            stderr: validation.stderr,
            rejectedPath: rejected,
            evidence: boundedEvidence(reason ?? ""),
          },
        );
      }
      await writeFile(`${file}.rig-backup`, before, { mode });
      await rename(temporary, file);
      if (options.reload !== false) {
        const reload = await runCaddy(reloadCommand).catch((error) => ({
          exitCode: 1,
          stdout: "",
          stderr: describeStartFailure(error),
        }));
        if (reload.exitCode !== 0) {
          await writeFile(temporary, before, { mode });
          await rename(temporary, file);
          const rollback = await runCaddy(reloadCommand).catch(() => ({
            exitCode: 1,
          }));
          const reason = lastOutputLine(reload.stderr);
          throw new RigError(
            "ROUTE_RELOAD",
            `Caddy could not reload${reason ? ` (${reason})` : ""}; the previous configuration was restored.`,
            rollback.exitCode
              ? "The rollback reload also failed. Inspect Caddy before retrying."
              : "Inspect Caddy diagnostics and retry.",
            {
              rollbackReloaded: rollback.exitCode === 0,
              stderr: reload.stderr,
              evidence: boundedEvidence(reason ?? ""),
            },
          );
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  /** A caddy that cannot start is a missing capability, not a route problem, so it is named as such. */
  async function runCaddy(command: readonly string[]) {
    try {
      return await run({ command });
    } catch (error) {
      if (error instanceof RigError && error.code === "COMMAND_START")
        throw new RigError(
          "CADDY_UNAVAILABLE",
          `Caddy could not start (${describeStartFailure(error)}).`,
          "Install Caddy and make it available on the PATH rigd inherits, then run rig doctor.",
          { executable: command[0], evidence: describeStartFailure(error) },
        );
      throw error;
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
function describeStartFailure(error: unknown): string {
  if (error instanceof RigError) {
    const cause = (error.details as { cause?: unknown } | undefined)?.cause;
    return typeof cause === "string" ? cause : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
/** Caddy serves one site per host and port; a bare address defaults to 443
 * (80 under http://), so `example.com` and `example.com:443` are one site and
 * `example.com:8443` is another. */
function siteAddress(address: string): string {
  const scheme = /^http:\/\//i.test(address) ? "http" : "https";
  const bare = address.replace(/^https?:\/\//i, "").toLowerCase();
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(bare)!;
  return `${match[1]}:${match[2] ?? (scheme === "http" ? "80" : "443")}`;
}
function hostnamePresent(text: string, hostname: string): boolean {
  const canonical = siteAddress(hostname);
  return text.split("\n").some((line) => {
    const header = line.trim().replace(/\s*#.*$/, "");
    if (!header.endsWith("{")) return false;
    return header
      .slice(0, -1)
      .split(/[\s,]+/)
      .filter(Boolean)
      .some((address) => siteAddress(address) === canonical);
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
