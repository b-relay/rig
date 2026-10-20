/** Publishes one release's files as the GitHub Release of its tag, safely for a re-run of the same tag. The files go into
 * a fresh draft, which stays private, and the draft is published only once every file is uploaded and matches. A draft
 * left by an interrupted run is deleted and replaced; a published release is never changed. The release workflow runs it:
 *
 *   bun scripts/publish-release.ts status <tag> <dist>    prints `publish` (nothing published yet) or `published`
 *   bun scripts/publish-release.ts publish <tag> <dist>   publishes <dist> as <tag>
 *
 * GITHUB_REPOSITORY names the repository (owner/name), and gh must be signed in with write access to its releases. */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage, RigError } from "../src/domain/errors";

export interface HostedAsset {
  readonly name: string;
  /** `sha256:<hex>`, or null when the host reports none. */
  readonly digest: string | null;
  /** `uploaded` once the whole file is stored. */
  readonly state: string;
}
export interface HostedRelease {
  readonly id: number;
  readonly tag: string;
  readonly draft: boolean;
  readonly assets: readonly HostedAsset[];
}
/** One file of a release as packaged: its name, where it is, and its SHA-256 in hex. */
export interface ReleaseFile {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
}
/** Where releases are published. */
export interface ReleaseHost {
  /** Every release of `tag`, drafts included. */
  releases(tag: string): Promise<readonly HostedRelease[]>;
  /** Deletes a release; the tag stays. */
  remove(id: number): Promise<void>;
  /** Creates a draft of `tag` holding `files`; it stays private until published. */
  createDraft(tag: string, files: readonly ReleaseFile[]): Promise<void>;
  publish(id: number): Promise<void>;
}

/** Pure: the names of the files a release of `tag` ships, sorted. */
export const releaseFileNames = (tag: string): readonly string[] =>
  [
    "SHA256SUMS",
    "install",
    `rig-${tag}-darwin-arm64.tar.gz`,
    `rig-${tag}-darwin-x64.tar.gz`,
  ].sort();

const publicationError = (
  message: string,
  hint: string,
  details: Record<string, unknown> = {},
) => new RigError("RELEASE_PUBLICATION", message, hint, details);

/** Reads the packaged files of `tag` from `dist`, which must hold exactly those files. */
export async function readReleaseFiles(
  tag: string,
  dist: string,
): Promise<readonly ReleaseFile[]> {
  const expected = releaseFileNames(tag);
  const found = (await readdir(dist)).sort();
  if (found.join("\n") !== expected.join("\n"))
    throw publicationError(
      `${dist} holds ${found.join(", ") || "nothing"}, not exactly the files of ${tag}.`,
      "Publish the directory scripts/package-release.sh built for this tag, unchanged.",
      { expected, found },
    );
  return await Promise.all(
    expected.map(async (name) => ({
      name,
      path: join(dist, name),
      sha256: createHash("sha256")
        .update(await readFile(join(dist, name)))
        .digest("hex"),
    })),
  );
}

/** Pure: whether `tag` still needs publishing (`publish`) or already is (`published`). Drafts do not count: publishing
 * replaces them. A published release missing any of the files is a failure, never repaired by replacing it. */
export function releaseState(
  tag: string,
  releases: readonly HostedRelease[],
): "publish" | "published" {
  const published = releases.find((release) => !release.draft);
  if (!published) return "publish";
  const names = published.assets
    .filter((asset) => asset.state === "uploaded")
    .map((asset) => asset.name)
    .sort();
  const expected = releaseFileNames(tag);
  if (names.join("\n") !== expected.join("\n"))
    throw publicationError(
      `${tag} is published with ${names.join(", ") || "no files"}, not exactly ${expected.join(", ")}.`,
      "A published release is never replaced. Compare its files with its SHA256SUMS and attestations by hand; if it must change, release a new version.",
      { release: published.id, expected, found: names },
    );
  return "published";
}

/** Pure: what is wrong with `draft` as the publication of `files`; empty when it holds exactly them, all uploaded. */
export function draftProblems(
  draft: HostedRelease,
  files: readonly ReleaseFile[],
): readonly string[] {
  const problems = files.flatMap((file) => {
    const asset = draft.assets.find(
      (candidate) => candidate.name === file.name,
    );
    if (!asset) return [`${file.name} is missing`];
    if (asset.state !== "uploaded")
      return [`${file.name} is ${asset.state}, not uploaded`];
    if (asset.digest !== null && asset.digest !== `sha256:${file.sha256}`)
      return [
        `${file.name} has digest ${asset.digest}, not sha256:${file.sha256}`,
      ];
    return [];
  });
  const extra = draft.assets.filter(
    (asset) => !files.some((file) => file.name === asset.name),
  );
  return [
    ...problems,
    ...extra.map((asset) => `${asset.name} is not part of the release`),
  ];
}

/** Publishes `files` as `tag` through a fresh draft, which is published only once it holds exactly them. Drafts of `tag`
 * left by an interrupted run are deleted first; a published release is never changed. */
export async function publishRelease(
  host: ReleaseHost,
  tag: string,
  files: readonly ReleaseFile[],
): Promise<void> {
  const existing = await host.releases(tag);
  if (releaseState(tag, existing) === "published")
    throw publicationError(
      `${tag} is already published.`,
      "A published release is never replaced; nothing was changed. Release a new version to change it.",
    );
  for (const draft of existing.filter((release) => release.draft))
    await host.remove(draft.id);
  await host.createDraft(tag, files);
  const drafts = (await host.releases(tag)).filter((release) => release.draft);
  const draft = drafts[0];
  if (!draft || drafts.length !== 1)
    throw publicationError(
      `Expected one draft of ${tag} after uploading it, found ${drafts.length}.`,
      "Another run may be publishing this tag. Let it finish, then re-run this one: it replaces any draft.",
    );
  const problems = draftProblems(draft, files);
  if (problems.length)
    throw publicationError(
      `The draft of ${tag} is incomplete: ${problems.join("; ")}.`,
      "Nothing was published. Re-run the release: it replaces the draft.",
      { release: draft.id, problems },
    );
  await host.publish(draft.id);
}

/** Runs gh with `args`; resolves with its standard output. */
export type GhRunner = (args: readonly string[]) => Promise<string>;

const runGh: GhRunner = async (args) => {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code)
    throw publicationError(
      `gh ${args.slice(0, 2).join(" ")} failed (exit ${code}): ${stderr.trim()}`,
      "Check gh is signed in with write access to the repository's releases, then re-run.",
      { args },
    );
  return stdout;
};

const releasePages = z.array(
  z.array(
    z.object({
      id: z.number(),
      tag_name: z.string(),
      draft: z.boolean(),
      assets: z.array(
        z.object({
          name: z.string(),
          digest: z.string().nullish(),
          state: z.string(),
        }),
      ),
    }),
  ),
);

/** The GitHub Releases of `repository` (owner/name), through gh. */
export function githubReleases(
  repository: string,
  gh: GhRunner = runGh,
): ReleaseHost {
  const releases = `repos/${repository}/releases`;
  return {
    async releases(tag) {
      const pages = releasePages.parse(
        JSON.parse(
          await gh([
            "api",
            "--paginate",
            "--slurp",
            `${releases}?per_page=100`,
          ]),
        ),
      );
      return pages
        .flat()
        .filter((release) => release.tag_name === tag)
        .map((release) => ({
          id: release.id,
          tag: release.tag_name,
          draft: release.draft,
          assets: release.assets.map((asset) => ({
            name: asset.name,
            digest: asset.digest ?? null,
            state: asset.state,
          })),
        }));
    },
    async remove(id) {
      await gh(["api", "--method", "DELETE", `${releases}/${id}`]);
    },
    async createDraft(tag, files) {
      await gh([
        "release",
        "create",
        tag,
        ...files.map((file) => file.path),
        "--repo",
        repository,
        "--draft",
        "--verify-tag",
        "--title",
        `Rig ${tag}`,
        "--generate-notes",
      ]);
    },
    async publish(id) {
      await gh([
        "api",
        "--method",
        "PATCH",
        `${releases}/${id}`,
        "-F",
        "draft=false",
      ]);
    },
  };
}

if (import.meta.main) {
  const [command, tag, dist] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  try {
    if (
      (command !== "status" && command !== "publish") ||
      !tag ||
      !dist ||
      !repository
    )
      throw publicationError(
        "usage: bun scripts/publish-release.ts status|publish <tag> <dist>",
        "Set GITHUB_REPOSITORY to owner/name.",
      );
    const host = githubReleases(repository);
    const files = await readReleaseFiles(tag, dist);
    if (command === "status")
      process.stdout.write(`${releaseState(tag, await host.releases(tag))}\n`);
    else {
      await publishRelease(host, tag, files);
      process.stdout.write(
        `Published ${tag}: ${files.map((file) => file.name).join(", ")}.\n`,
      );
    }
  } catch (error) {
    const hint = error instanceof RigError ? `\n${error.hint}` : "";
    process.stderr.write(`publish-release: ${errorMessage(error)}${hint}\n`);
    process.exit(1);
  }
}
