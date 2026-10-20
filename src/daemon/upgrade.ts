import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RigError } from "../domain/errors";
import type { DaemonStatus } from "./admin";

/** Where releases are downloaded from, as the install script reads it: `<releases>/<tag>/<file>`. */
export const RELEASES = "https://github.com/b-relay/rig/releases/download";
/** The most redirects one download follows; GitHub's asset downloads take two. */
const MAX_REDIRECTS = 5;

/** What `rigd upgrade` asks for: a release by version, or the latest; and whether only to say what it would do. */
export interface UpgradeRequest {
  /** `0.2.0` or `v0.2.0`; absent, the latest release. */
  readonly version?: string;
  readonly check?: boolean;
}
/** What `rigd upgrade` found or did. */
export interface UpgradeResult {
  /** current: the release asked for is the one installed. available: `--check` found another. upgraded: installed it.
   * incomplete: `--check` found the release's rigd installed but not the rest (see `missing`). completed: installed the
   * rest. */
  readonly outcome:
    "current" | "available" | "upgraded" | "incomplete" | "completed";
  /** The release asked for, such as v0.2.0. */
  readonly release: string;
  /** The release the Rig root's rigd is, such as v0.1.0; absent when it has none. */
  readonly installed?: string;
  /** Whether the release was named; otherwise it is the latest. */
  readonly named: boolean;
  /** What the installation of the release lacked, when its rigd was installed without the rest. */
  readonly missing?: string;
}
export interface UpgradeDependencies {
  /** `<releases>/<tag>/<file>` downloads a release's file; `RELEASES` unless tests point it at local files. */
  readonly releases: string;
  /** A request that never follows a redirect itself (`redirect: "manual"`), so every hop is checked here. */
  fetch(url: string): Promise<Response>;
  /** The release number of the rigd installed in the Rig root, such as 0.1.0; undefined when there is none. */
  installedRelease(): Promise<string | undefined>;
  /** What the installation of `release` (such as v0.2.0) lacks besides its rigd (see installationGap); undefined when it is
   * complete. */
  missing(release: string): Promise<string | undefined>;
  /** Runs a release's install script, its output shown as it runs; resolves to its exit code. The script finds the Rig
   * root as rigd does (RIG_ROOT when set, else ~/.rig), and so does the rigd install it runs. */
  install(script: string, env: Record<string, string>): Promise<number>;
}

/** Pure: the tag of a release version, `0.2.0` or `v0.2.0` alike; refuses anything else. */
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
 * Which release is decided first, by name or by GitHub's latest-release redirect; that release's script must name it,
 * and must match that release's SHA256SUMS, before it runs. */
export async function upgrade(
  deps: UpgradeDependencies,
  request: UpgradeRequest,
): Promise<UpgradeResult> {
  const named = request.version !== undefined;
  const release = named
    ? releaseTag(request.version!)
    : await latestRelease(deps);
  const installedNumber = await deps.installedRelease();
  const installed = installedNumber ? `v${installedNumber}` : undefined;
  // A release whose install failed after its rigd was replaced is installed again, not taken as current.
  const missing =
    release === installed ? await deps.missing(release) : undefined;
  const result = (outcome: UpgradeResult["outcome"]): UpgradeResult => ({
    outcome,
    release,
    ...(installed ? { installed } : {}),
    named,
    ...(missing ? { missing } : {}),
  });
  if (release === installed && !missing) return result("current");
  // Fetched before anything is said to be available, so a release that does not exist is named as such.
  const script = await download(deps, `${deps.releases}/${release}/install`);
  const names = /^version="(v\d+\.\d+\.\d+)"$/m.exec(
    new TextDecoder().decode(script),
  )?.[1];
  if (names !== release)
    throw new RigError(
      "UPGRADE_FAILED",
      `The install script of ${release} installs ${names ?? "no release"}.`,
      "That release is not as published; nothing was changed.",
      { release },
    );
  if (request.check) return result(missing ? "incomplete" : "available");
  const sums = new TextDecoder().decode(
    await download(deps, `${deps.releases}/${release}/SHA256SUMS`),
  );
  const listed = sums
    .split("\n")
    .filter((line) => /^[0-9a-f]{64} {2}install$/.test(line));
  const digest = createHash("sha256").update(script).digest("hex");
  if (listed.length !== 1 || listed[0]!.slice(0, 64) !== digest)
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
    const code = await deps.install(
      file,
      deps.releases === RELEASES ? {} : { RIG_RELEASE_URL: deps.releases },
    );
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
  return result(missing ? "completed" : "upgraded");
}

/** The latest release's tag, from where GitHub's latest-release page redirects: `<repository>/releases/tag/<tag>`. */
async function latestRelease(
  deps: Pick<UpgradeDependencies, "fetch" | "releases">,
): Promise<string> {
  const url = deps.releases.replace(/\/download$/, "/latest");
  const response = await request(deps, url, schemeOf(url));
  const tag = /\/releases\/tag\/(v\d+\.\d+\.\d+)$/.exec(
    response.headers.get("location") ?? "",
  )?.[1];
  if (!tag)
    throw new RigError(
      "UPGRADE_DOWNLOAD",
      response.status === 404
        ? "There is no release of Rig yet."
        : `${url} did not name the latest release (HTTP ${response.status}).`,
      "Try again later, or name a release: rigd upgrade 0.2.0. Nothing was changed.",
      { url },
    );
  return tag;
}

/** A release file's bytes. Every redirect is followed here, and each address must be HTTPS (file:// is for tests). */
async function download(
  deps: Pick<UpgradeDependencies, "fetch">,
  url: string,
): Promise<Uint8Array> {
  // Every hop stays on the scheme the download began with: HTTPS for a release, file:// only for a test's local tree.
  const scheme = schemeOf(url);
  let address = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await request(deps, address, scheme);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location)
        throw failure(url, `a redirect from ${address} named no address`);
      try {
        address = new URL(location, address).toString();
      } catch {
        throw failure(url, `a redirect from ${address} named no valid address`);
      }
      continue;
    }
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
      throw failure(
        url,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  throw failure(url, `more than ${MAX_REDIRECTS} redirects`);
}
/** Pure: the scheme a download may use: file:// for a test's local tree, HTTPS for everything else. */
function schemeOf(url: string): "https://" | "file://" {
  return url.startsWith("file://") ? "file://" : "https://";
}
/** One request to an address on `scheme`, never following a redirect itself. */
async function request(
  deps: Pick<UpgradeDependencies, "fetch">,
  address: string,
  scheme: "https://" | "file://",
): Promise<Response> {
  if (!address.startsWith(scheme))
    throw failure(
      address,
      scheme === "https://"
        ? "it is not HTTPS"
        : "it leaves the local release tree",
    );
  try {
    return await deps.fetch(address);
  } catch (error) {
    throw failure(
      address,
      error instanceof Error ? error.message : String(error),
    );
  }
}
function failure(url: string, why: string): RigError {
  return new RigError(
    "UPGRADE_DOWNLOAD",
    `Could not download ${url}: ${why}.`,
    "Check the network and the release version; nothing was changed.",
    { url },
  );
}

/** The release number of the rigd at `executable`, from its version (`0.1.0+<commit>`); undefined when there is none
 * there, or it reports no release. Effect owner over running it. */
export async function installedRelease(
  executable: string,
): Promise<string | undefined> {
  try {
    const child = Bun.spawn([executable, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    return code === 0
      ? /^(\d+\.\d+\.\d+)\+/.exec(output.trim())?.[1]
      : undefined;
  } catch {
    return undefined;
  }
}

/** What the installation of `release` (such as v0.2.0) in `root` lacks besides its rigd, as a phrase; undefined when it
 * is complete: `rig` of the same release, the release's dashboard, and rigd installed and serving that release. The install
 * script replaces rig and rigd before it runs rigd install, so a failure after that leaves rigd of the release alone. */
export async function installationGap(
  root: string,
  release: string,
  status: () => Promise<DaemonStatus>,
): Promise<string | undefined> {
  const number = release.slice(1);
  if ((await installedRelease(join(root, "bin", "rig"))) !== number)
    return `rig in ${join(root, "bin")} is not ${release}`;
  const server = join(root, "dashboard", release, "web", "server.js");
  if (
    !(await stat(server).then(
      (info) => info.isFile(),
      () => false,
    ))
  )
    return `its dashboard has no ${server}`;
  const daemon = await status();
  if (!daemon.installed) return "rigd is not installed";
  if (!daemon.reachable) return "rigd is not running";
  if (!daemon.version?.startsWith(`${number}+`))
    return `rigd ${daemon.version ?? "of an older release"} is serving`;
  return undefined;
}

/** Pure: the environment a release's install script runs in, from rigd's own: RIG_ROOT as rigd resolved it when one was
 * set, and none otherwise, so the script and its rigd install find the root as rigd does (a LaunchAgent stays one). */
export function installEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  root: string,
): Record<string, string | undefined> {
  const { RIG_ROOT, ...rest } = environment;
  return { ...rest, ...(RIG_ROOT ? { RIG_ROOT: root } : {}) };
}
