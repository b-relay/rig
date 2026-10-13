import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RigError } from "../domain/errors";

/** Where releases are downloaded from, as the install script reads it: `<releases>/<tag>/<file>`. */
export const RELEASES = "https://github.com/b-relay/rig/releases/download";

/** What `rigd upgrade` asks for: a release by version, or the latest; and whether only to say what it would do. */
export interface UpgradeRequest {
  /** `0.2.0` or `v0.2.0`; absent, the latest release. */
  readonly version?: string;
  readonly check?: boolean;
}
/** What `rigd upgrade` found or did. */
export interface UpgradeResult {
  /** current: the release asked for is the one installed. available: `--check` found another. upgraded: installed it. */
  readonly outcome: "current" | "available" | "upgraded";
  /** The release asked for, such as v0.2.0. */
  readonly release: string;
  /** The release this rigd is, such as v0.1.0. */
  readonly installed: string;
  /** Whether the release was named; otherwise it is the latest. */
  readonly named: boolean;
}
export interface UpgradeDependencies {
  readonly root: string;
  /** `<releases>/<tag>/<file>` downloads a release's file; `RELEASES` unless tests point it at local files. */
  readonly releases: string;
  /** This rigd's release number, such as 0.1.0. */
  readonly current: string;
  fetch(url: string): Promise<Response>;
  /** Runs a release's install script with the Rig root, its output shown as it runs; resolves to its exit code. */
  install(script: string, env: Record<string, string>): Promise<number>;
}

/** The release `request` names, as a tag; refuses anything but a version number. */
export function releaseTag(version: string): string {
  if (!/^v?\d+\.\d+\.\d+$/.test(version))
    throw new RigError(
      "USAGE",
      `${JSON.stringify(version)} is not a release version.`,
      "Name one such as 0.2.0 or v0.2.0, or none for the latest release.",
    );
  return version.startsWith("v") ? version : `v${version}`;
}

/** Upgrades (or rolls back) Rig to a release through that release's own install script, the one a first install runs:
 * it checks the archive against SHA256SUMS, stages rig, rigd and the dashboard, replaces them, and runs rigd install.
 * The script itself is checked against the same release's SHA256SUMS before it runs. The latest release's tag is read
 * from the install script GitHub serves as the latest, which names the release it installs. */
export async function upgrade(
  deps: UpgradeDependencies,
  request: UpgradeRequest,
): Promise<UpgradeResult> {
  const installed = `v${deps.current}`;
  const named = request.version !== undefined;
  const latest = deps.releases.replace(/\/download$/, "/latest/download");
  const script = await download(
    deps,
    named
      ? `${deps.releases}/${releaseTag(request.version!)}/install`
      : `${latest}/install`,
  );
  const release = scriptRelease(script);
  if (named && release !== releaseTag(request.version!))
    throw new RigError(
      "UPGRADE_FAILED",
      `The install script of ${releaseTag(request.version!)} installs ${release}.`,
      "That release is not as published; nothing was changed.",
    );
  if (release === installed)
    return { outcome: "current", release, installed, named };
  if (request.check) return { outcome: "available", release, installed, named };
  const sums = new TextDecoder().decode(
    await download(deps, `${deps.releases}/${release}/SHA256SUMS`),
  );
  const expected = sums
    .split("\n")
    .filter((line) => /^[0-9a-f]{64} {2}install$/.test(line));
  const digest = createHash("sha256").update(script).digest("hex");
  if (expected.length !== 1 || expected[0]!.slice(0, 64) !== digest)
    throw new RigError(
      "UPGRADE_FAILED",
      `The install script of ${release} does not match its SHA256SUMS.`,
      "Nothing was changed. Try again; if it persists, check the release on GitHub.",
      { release },
    );
  const work = await mkdtemp(join(tmpdir(), "rigd-upgrade-"));
  try {
    const file = join(work, "install");
    await writeFile(file, script, { mode: 0o600 });
    const code = await deps.install(file, {
      RIG_ROOT: deps.root,
      ...(deps.releases === RELEASES ? {} : { RIG_RELEASE_URL: deps.releases }),
    });
    if (code !== 0)
      throw new RigError(
        "UPGRADE_FAILED",
        `Installing ${release} failed; its install script exited with code ${code}.`,
        "Its output above says why. What it had not replaced is unchanged; rigd status shows what runs.",
        { release, code },
      );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { outcome: "upgraded", release, installed, named };
}

/** Pure: the release an install script installs, from its `version="vX.Y.Z"` line. */
function scriptRelease(script: Uint8Array): string {
  const release = /^version="(v\d+\.\d+\.\d+)"$/m.exec(
    new TextDecoder().decode(script),
  )?.[1];
  if (!release)
    throw new RigError(
      "UPGRADE_FAILED",
      "The downloaded install script names no release.",
      "Nothing was changed. Try again; if it persists, check the release on GitHub.",
    );
  return release;
}

/** A release file's bytes, over HTTPS only, redirects included (file:// is for tests); a missing release is named. */
async function download(
  deps: Pick<UpgradeDependencies, "fetch">,
  url: string,
): Promise<Uint8Array> {
  const allowed = (address: string) =>
    address.startsWith("https://") || address.startsWith("file://");
  let response: Response;
  try {
    if (!allowed(url)) throw new Error("not HTTPS");
    response = await deps.fetch(url);
  } catch (error) {
    throw new RigError(
      "UPGRADE_DOWNLOAD",
      `Could not download ${url}: ${error instanceof Error ? error.message : String(error)}.`,
      "Check the network and the release version; nothing was changed.",
      { url },
    );
  }
  if (response.url && !allowed(response.url))
    throw new RigError(
      "UPGRADE_DOWNLOAD",
      `${url} redirected to ${response.url}, which is not HTTPS.`,
      "Nothing was changed.",
      { url },
    );
  if (!response.ok)
    throw new RigError(
      "UPGRADE_DOWNLOAD",
      response.status === 404
        ? `No such release file: ${url}.`
        : `Could not download ${url}: HTTP ${response.status}.`,
      response.status === 404
        ? "Check the version: rigd upgrade --check names the latest. Nothing was changed."
        : "Try again; nothing was changed.",
      { url, status: response.status },
    );
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    // A local file that is not there fails only as it is read.
    throw new RigError(
      "UPGRADE_DOWNLOAD",
      `Could not download ${url}: ${error instanceof Error ? error.message : String(error)}.`,
      "Check the network and the release version; nothing was changed.",
      { url },
    );
  }
}
