import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  RigError,
  boundedEvidence,
  errorMessage,
  lastOutputLine,
} from "../domain/errors";
import type { ConvexBackendReleases } from "../helpers/convex-contracts";
import { backendRelease } from "../helpers/convex-deployment";
import type { CommandRunner } from "./contracts";

/** Where Convex publishes its recommended local backend release and the release archives. */
export const CONVEX_RELEASE_SOURCES = {
  recommended: "https://version.convex.dev/v1/local_backend_version",
  downloads: "https://github.com/get-convex/convex-backend/releases/download",
} as const;
const EXECUTABLE = "convex-local-backend";
const LOOKUP_MS = 5_000;
const recommendation = z.object({ version: backendRelease });

/** Convex's releases through the cache `convex dev` uses: `<home>/.cache/convex/binaries/<release>/convex-local-backend`.
 * A download is unpacked beside the cache and moved in whole, so a half-written binary is never found there. `run`
 * unpacks archives with `unzip` from `PATH`. */
export function createConvexReleases(input: {
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  run: CommandRunner;
  /** PATH for `unzip`. */
  PATH: string | undefined;
  fetch: typeof fetch;
  sources?: { recommended: string; downloads: string };
}): ConvexBackendReleases {
  const cache = join(input.home, ".cache", "convex", "binaries");
  const sources = input.sources ?? CONVEX_RELEASE_SOURCES;
  const binaryOf = (release: string) => join(cache, release, EXECUTABLE);
  return {
    async recommended(signal) {
      try {
        const response = await input.fetch(sources.recommended, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_MS)]),
        });
        if (!response.ok) return undefined;
        const parsed = recommendation.safeParse(await response.json());
        return parsed.success ? parsed.data.version : undefined;
      } catch {
        return undefined;
      }
    },
    async cached() {
      let names: string[];
      try {
        names = await readdir(cache);
      } catch {
        return [];
      }
      const found = await Promise.all(
        names.map(async (name) =>
          backendRelease.safeParse(name).success &&
          (await executable(binaryOf(name)))
            ? name
            : undefined,
        ),
      );
      return found.filter((name) => name !== undefined);
    },
    async binary(release, signal) {
      if (!backendRelease.safeParse(release).success)
        throw new RigError(
          "CONVEX_BACKEND_DOWNLOAD",
          `'${boundedEvidence(release) ?? ""}' is not a Convex backend release name.`,
          "Pass a release such as precompiled-2026-09-21-0cf49cb, as named in ~/.cache/convex/binaries.",
        );
      const binary = binaryOf(release);
      if (await executable(binary)) return binary;
      const asset = assetName(input.platform, input.arch);
      const url = `${sources.downloads}/${release}/${asset}`;
      const failure = (reason: string) =>
        new RigError(
          "CONVEX_BACKEND_DOWNLOAD",
          `Convex backend ${release} is not in ${cache} and could not be downloaded (${reason}).`,
          "Start the Service again with a network connection, or pass --backend-version with a release already in that directory.",
          { release, url, evidence: boundedEvidence(reason) },
        );
      await mkdir(cache, { recursive: true });
      const staging = await mkdtemp(join(cache, `.rig-${release}-`));
      try {
        let response: Response;
        try {
          response = await input.fetch(url, { signal });
        } catch (error) {
          throw failure(errorMessage(error));
        }
        if (!response.ok) throw failure(`HTTP ${response.status} from ${url}`);
        const archive = join(staging, asset);
        await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
        const unpacked = await input
          .run({
            command: ["unzip", "-o", "-q", archive, "-d", staging],
            ...(input.PATH === undefined ? {} : { env: { PATH: input.PATH } }),
            signal,
          })
          .catch((error: unknown) => {
            throw failure(
              `unzip could not run: ${errorMessage(error)}; it must be on PATH`,
            );
          });
        if (unpacked.exitCode !== 0)
          throw failure(
            `unzip failed: ${lastOutputLine(unpacked.stderr) ?? `exit code ${unpacked.exitCode}`}`,
          );
        const staged = join(staging, EXECUTABLE);
        if (!(await exists(staged)))
          throw failure(`the archive has no ${EXECUTABLE}`);
        await chmod(staged, 0o755);
        await mkdir(join(cache, release), { recursive: true });
        await rename(staged, binary);
        return binary;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
  };
}
/** The archive Convex publishes for this platform. Throws CONVEX_PLATFORM where it publishes none. */
export function assetName(platform: NodeJS.Platform, arch: string): string {
  const cpu = { arm64: "aarch64", x64: "x86_64" }[arch];
  const system = { darwin: "apple-darwin", linux: "unknown-linux-gnu" }[
    platform as "darwin" | "linux"
  ];
  if (!cpu || !system)
    throw new RigError(
      "CONVEX_PLATFORM",
      `Convex publishes no local backend for ${platform} on ${arch}.`,
      "Run the Service on a Mac or on Linux, on arm64 or x64.",
      { platform, arch },
    );
  return `convex-local-backend-${cpu}-${system}.zip`;
}
async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
