import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { RigError } from "../domain/errors";
import type { ProxyPaths } from "../domain/managed-proxy";
import type { CommandRunner } from "./contracts";

/** The oldest Caddy Rig runs: from 2.10 a managed wildcard certificate covers its subdomains without `prefer_wildcard`. */
export const MINIMUM_CADDY = [2, 10] as const;

/** What installing a binary did: whether the job's binary changed, and the file it ran before, for a way back. */
export interface BinaryInstallation {
  readonly changed: boolean;
  /** The immutable copy the job runs now. */
  readonly file: string;
  /** The copy it ran before, when it changed. */
  readonly previous?: string;
  readonly version: string;
}
/** The version a `caddy version` line reports, such as v2.10.2. */
export function caddyVersion(output: string): [number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\./m.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}
/** The copy the job's `bin/caddy` symlink points at, or undefined before the first install. */
export async function installedBinary(
  paths: ProxyPaths,
): Promise<string | undefined> {
  const target = await readlink(paths.binary).catch(() => undefined);
  return target ? join(paths.bin, basename(target)) : undefined;
}
/** Points the job's binary at `file` by renaming a new symlink over the old one, so the switch is atomic. */
export async function switchBinary(
  paths: ProxyPaths,
  file: string,
): Promise<void> {
  const temporary = `${paths.binary}.${randomUUID()}.tmp`;
  await symlink(basename(file), temporary);
  await rename(temporary, paths.binary);
}
/** Copies `source` into an immutable `caddy-<sha256 prefix>` beside the job's binary and checks it: version 2.10 or later,
 * the DNS provider module, and, through `validate`, the current configuration. Only then does the job's symlink switch to
 * it. A failed check changes nothing (PROXY_BINARY). */
export async function installCaddyBinary(options: {
  readonly source: string;
  readonly paths: ProxyPaths;
  /** The DNS provider name, such as cloudflare; its module must be in the binary. */
  readonly dns: string;
  readonly run: CommandRunner;
  /** Validates the current configuration with a candidate binary; absent before the first generation. */
  readonly validate?: (binary: string) => Promise<void>;
}): Promise<BinaryInstallation> {
  const { paths } = options;
  const refuse = (message: string, hint: string) =>
    new RigError("PROXY_BINARY", message, hint, { source: options.source });
  let content: Buffer;
  try {
    if (!(await stat(options.source)).isFile()) throw new Error("not a file");
    content = await readFile(options.source);
  } catch {
    throw refuse(
      `proxy.caddy names ${options.source}, which is not a readable file.`,
      "Set proxy.caddy in Host config to a Caddy executable built with the DNS module.",
    );
  }
  const digest = createHash("sha256").update(content).digest("hex");
  const file = join(paths.bin, `caddy-${digest.slice(0, 16)}`);
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  if (!(await stat(file).catch(() => undefined))) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await copyFile(options.source, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, file);
  }
  const version = await checkCaddyBinary({ ...options, file });
  const previous = await installedBinary(paths);
  if (previous === file) return { changed: false, file, version };
  await options.validate?.(file);
  await switchBinary(paths, file);
  await pruneBinaries(paths, [file, previous]);
  return { changed: true, file, ...(previous ? { previous } : {}), version };
}
/** Checks that `file` runs as Caddy 2.10 or later with the DNS provider module, and resolves to its version. `source` names
 * it in a refusal (PROXY_BINARY). `rigd install` runs this on proxy.caddy itself before it stops rigd, so a binary it would
 * refuse never costs a restart. */
export async function checkCaddyBinary(options: {
  readonly file: string;
  readonly source: string;
  readonly dns: string;
  readonly run: CommandRunner;
}): Promise<string> {
  const refuse = (message: string, hint: string) =>
    new RigError("PROXY_BINARY", message, hint, { source: options.source });
  const run = async (args: string[]) =>
    options.run({ command: [options.file, ...args] }).catch(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "",
    }));
  const version = await run(["version"]);
  const parsed = caddyVersion(version.stdout);
  if (
    version.exitCode !== 0 ||
    !parsed ||
    parsed[0] < MINIMUM_CADDY[0] ||
    (parsed[0] === MINIMUM_CADDY[0] && parsed[1] < MINIMUM_CADDY[1])
  )
    throw refuse(
      `${options.source} is not Caddy ${MINIMUM_CADDY.join(".")} or later (it reports ${version.stdout.trim().split("\n")[0] || "no version"}).`,
      "Point proxy.caddy at Caddy 2.10 or later built with the DNS module.",
    );
  const modules = await run(["list-modules"]);
  if (!modules.stdout.split("\n").includes(`dns.providers.${options.dns}`))
    throw refuse(
      `${options.source} does not include the dns.providers.${options.dns} module.`,
      `Build or download Caddy with github.com/caddy-dns/${options.dns}, for example from https://caddyserver.com/download, and point proxy.caddy at it.`,
    );
  return version.stdout.trim().split(" ")[0]!;
}
/** Deletes binary copies other than `keep`. */
async function pruneBinaries(
  paths: ProxyPaths,
  keep: readonly (string | undefined)[],
): Promise<void> {
  const kept = new Set(keep.filter(Boolean).map((path) => basename(path!)));
  for (const name of await readdir(paths.bin).catch(() => []))
    if (/^caddy-[0-9a-f]{16}$/.test(name) && !kept.has(name))
      await rm(join(paths.bin, name), { force: true });
}
