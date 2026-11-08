import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { replacePrivateFile } from "../providers/private-files";
import { RigError } from "../domain/errors";
import { daemonTokenPath } from "./files";
import {
  installationPath,
  readInstallationRecord,
  type DaemonMode,
  type InstallationRecord,
} from "./installation";
import type { ProxyMode } from "../config/proxy-schema";

/** The record an install writes for the rigd `command` of build `version`, started in `mode`. `bun` is what the daemon about
 * to start will read; a daemon already running read its own at startup. */
export function installationRecord(fields: {
  mode: DaemonMode;
  command: readonly string[];
  version: string;
  bun?: string | undefined;
  proxy?: ProxyMode | undefined;
}): InstallationRecord {
  return {
    mode: fields.mode,
    command: [...fields.command],
    version: fields.version,
    ...(fields.bun ? { bun: fields.bun } : {}),
    ...(fields.proxy ? { proxy: fields.proxy } : {}),
  };
}
/** Written whole, through a sibling temp file and rename, because a starting daemon reads it. */
export async function writeInstallation(
  root: string,
  record: InstallationRecord,
): Promise<void> {
  await replacePrivateFile(
    root,
    installationPath(root),
    JSON.stringify(record),
  );
}
/** Called only once the record is known to exist, so an absent one is as unreadable as a torn one. */
export async function readInstallation(
  root: string,
): Promise<InstallationRecord> {
  const installation = await readInstallationRecord(root);
  if (!installation)
    throw new RigError(
      "DAEMON_INSTALL_STATE",
      "The installation record is unreadable.",
      "Inspect the daemon installation before retrying.",
      { path: installationPath(root) },
    );
  return installation;
}
/** A fresh control-plane credential for the rigd about to start. A credential that cannot be written is named by path; a raw
 * fs error would send the user to the diagnostic log. */
export async function issueToken(root: string): Promise<void> {
  const tokenPath = daemonTokenPath(root);
  try {
    // Replaced, never written through: a link planted at the path is replaced and what it led to is untouched.
    await replacePrivateFile(
      root,
      tokenPath,
      randomBytes(32).toString("base64url"),
    );
  } catch (error) {
    if (error instanceof RigError) throw error;
    const cause = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    throw new RigError(
      "DAEMON_TOKEN",
      `The daemon credential at ${tokenPath} cannot be written (${cause}).`,
      `Make ${tokenPath} and its directory writable by you, then retry rigd install.`,
      { path: tokenPath, cause },
    );
  }
}
/** Removes the installation record, then the credential. */
export async function removeRecordAndToken(root: string): Promise<void> {
  await rm(installationPath(root), { force: true });
  await rm(daemonTokenPath(root), { force: true });
}
