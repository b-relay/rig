import { randomUUID } from "node:crypto";
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
import {
  editRouteFile,
  ownedBlock,
  withheldPaths,
  type RouteCheckpoint,
  type RouteRequest,
  type Router,
} from "./route-file";
export type {
  RouteCheckpoint,
  RoutePath,
  RouteRequest,
  RouteSite,
  Router,
  WithheldPath,
} from "./route-file";
/** The router for a Caddy Rig does not run (`providers.caddy`, retiring after ADR 0014's rollback window). Only marked Rig
 * blocks are mutable; each change validates before publishing and rolls back on reload failure. */
export function createCaddyRouter(options: {
  readonly caddyfile: string;
  /** Runs caddy validate and the reload command; the daemon passes the platform runner, a test a fake. */
  readonly run: CommandRunner;
  readonly executable?: string;
  readonly reload?: boolean;
  readonly reloadCommand?: readonly string[];
  readonly extraConfig?: readonly string[];
  /** The Host Caddyfile that imports the route file, asked on every change because the import can be added while rigd runs.
   * With one, routes are checked through it, so they may use snippets it defines; without one, the route file is checked alone. */
  readonly hostCaddyfile?: () => Promise<string | undefined>;
}): Router {
  const { run } = options;
  let pending: Promise<unknown> = Promise.resolve();
  async function change(
    key: string,
    route?: RouteRequest,
    restoration?: { saved: RouteCheckpoint; expected: RouteCheckpoint },
  ): Promise<void> {
    await mkdir(dirname(options.caddyfile), { recursive: true });
    const before = await readFile(options.caddyfile, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const edit = editRouteFile({
      before,
      key,
      ...(route ? { route } : {}),
      ...(restoration ? { restoration } : {}),
      siteConfig: options.extraConfig ?? [],
    });
    // Nothing owned to remove and nothing to add leaves the file, and Caddy, untouched.
    if (!edit) return;
    const { after, withdrawing } = edit;
    if (after === before && !withdrawing) return;
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
    const hostCaddyfile = await options.hostCaddyfile?.();
    try {
      await writeFile(temporary, after, { mode });
      // Caddy reads an import from disk, so a check through the Host Caddyfile needs the new routes in place first. Caddy serves
      // what it last loaded, not the file, so a rejected change is put back before anything reloads. It is adapted rather than
      // validated: validating provisions TLS with Host secrets rigd does not hold, and the reload provisions it inside Caddy anyway.
      if (hostCaddyfile) {
        await writeFile(`${file}.rig-backup`, before, { mode });
        await rename(temporary, file);
      }
      const validation = await runCaddy(
        hostCaddyfile
          ? [
              executable,
              "adapt",
              "--config",
              hostCaddyfile,
              "--adapter",
              "caddyfile",
            ]
          : [
              executable,
              "validate",
              "--config",
              temporary,
              "--adapter",
              "caddyfile",
            ],
      ).catch(async (error) => {
        if (hostCaddyfile) await writeFile(file, before, { mode });
        throw error;
      });
      if (validation.exitCode !== 0) {
        // The rejected text is kept where the hint names it so the user can read what Caddy saw.
        if (hostCaddyfile) {
          await writeFile(rejected, after, { mode });
          await writeFile(temporary, before, { mode });
          await rename(temporary, file);
        } else await rename(temporary, rejected);
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
      if (!hostCaddyfile) {
        await writeFile(`${file}.rig-backup`, before, { mode });
        await rename(temporary, file);
      }
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
    async withheld(key) {
      await pending.catch(() => {});
      const text = await readFile(options.caddyfile, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return withheldPaths(ownedBlock(text, key) ?? "");
    },
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
export function describeStartFailure(error: unknown): string {
  if (error instanceof RigError) {
    const cause = (error.details as { cause?: unknown } | undefined)?.cause;
    return typeof cause === "string" ? cause : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
