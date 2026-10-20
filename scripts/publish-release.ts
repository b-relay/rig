/** Publishes one release's files as the GitHub Release of its tag, safely for a re-run of the same tag. The files go into
 * a fresh draft, which stays private, and the draft is published only once every file is uploaded with this run's bytes.
 * A draft left by an interrupted run is deleted and replaced; a published release is never changed. The release
 * workflow runs it:
 *
 *   bun scripts/publish-release.ts status <tag> <commit> <dist>    prints `publish` (nothing published yet) or `published`
 *   bun scripts/publish-release.ts publish <tag> <commit> <dist>   publishes <dist> as <tag>
 *
 * <commit> is the full SHA the run built, which the tag must still name. GITHUB_REPOSITORY names the repository
 * (owner/name), and gh must be signed in with write access to its releases. */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage, RigError } from "../src/domain/errors";

export interface HostedAsset {
  readonly id: number;
  readonly name: string;
  /** `sha256:<hex>` as the host computed it, or null when it reports none. */
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
  /** The full SHA of the commit `tag` names now. */
  tagCommit(tag: string): Promise<string>;
  /** The bytes of an asset, a draft's included. */
  download(asset: number): Promise<Uint8Array>;
  /** Why `bytes`, named `name`, carry no build provenance from the release workflow for `tag` at `commit`; undefined
   * when they do. */
  provenanceProblem(
    name: string,
    bytes: Uint8Array,
    tag: string,
    commit: string,
  ): Promise<string | undefined>;
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

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

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
      sha256: sha256(await readFile(join(dist, name))),
    })),
  );
}

/** Pure: the SHA-256 per file a SHA256SUMS lists, or undefined unless every line is exactly `<64 hex>  <name>` and no
 * name repeats. */
export function parseSums(text: string): Map<string, string> | undefined {
  const sums = new Map<string, string>();
  for (const line of text.split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!match || sums.has(match[2]!)) return undefined;
    sums.set(match[2]!, match[1]!);
  }
  return sums;
}

/** An asset's SHA-256 in hex: the host's digest when it reports one, otherwise the hash of its downloaded bytes. */
async function assetSha256(
  host: ReleaseHost,
  asset: HostedAsset,
): Promise<string> {
  return asset.digest?.startsWith("sha256:")
    ? asset.digest.slice("sha256:".length)
    : sha256(await host.download(asset.id));
}

/** Fails unless `tag` still names `commit`, the commit this run built: a tag moved since is never published from here. */
async function checkTag(host: ReleaseHost, tag: string, commit: string) {
  const named = await host.tagCommit(tag);
  if (named !== commit)
    throw publicationError(
      `${tag} now names ${named}, not ${commit}, the commit this run built.`,
      "Nothing was changed. Let the run of the tag's current commit publish it.",
      { tag, named, commit },
    );
}

/** What is wrong with `release`, published as `tag` from `commit`: it must hold exactly the release's files, each
 * matching the SHA-256 its SHA256SUMS lists, and that SHA256SUMS must carry the release workflow's provenance for `tag`
 * at `commit`. Empty when it is complete. */
export async function publishedProblems(
  host: ReleaseHost,
  tag: string,
  commit: string,
  release: HostedRelease,
): Promise<readonly string[]> {
  const uploaded = release.assets.filter((asset) => asset.state === "uploaded");
  const names = uploaded.map((asset) => asset.name).sort();
  const expected = releaseFileNames(tag);
  if (names.join("\n") !== expected.join("\n"))
    return [
      `it holds ${names.join(", ") || "no files"}, not exactly ${expected.join(", ")}`,
    ];
  const sumsAsset = uploaded.find((asset) => asset.name === "SHA256SUMS")!;
  const sumsBytes = await host.download(sumsAsset.id);
  if (sha256(sumsBytes) !== (await assetSha256(host, sumsAsset)))
    return ["its SHA256SUMS does not match the digest GitHub reports for it"];
  const sums = parseSums(new TextDecoder().decode(sumsBytes));
  const listed = expected.filter((name) => name !== "SHA256SUMS");
  if (!sums || [...sums.keys()].sort().join("\n") !== listed.join("\n"))
    return [`its SHA256SUMS does not list exactly ${listed.join(", ")}`];
  const problems: string[] = [];
  for (const asset of uploaded.filter((asset) => asset !== sumsAsset)) {
    const digest = await assetSha256(host, asset);
    if (digest !== sums.get(asset.name))
      problems.push(
        `${asset.name} is ${digest}, not ${sums.get(asset.name)} as its SHA256SUMS lists`,
      );
  }
  const provenance = await host.provenanceProblem(
    "SHA256SUMS",
    sumsBytes,
    tag,
    commit,
  );
  if (provenance)
    problems.push(
      `its SHA256SUMS has no provenance for ${commit}: ${provenance}`,
    );
  return problems;
}

/** Whether `tag` still needs publishing (`publish`) or already is, completely (`published`). Drafts do not count:
 * publishing replaces them. A published release that is not complete is a failure, never repaired by replacing it. */
export async function releaseState(
  host: ReleaseHost,
  tag: string,
  commit: string,
): Promise<"publish" | "published"> {
  await checkTag(host, tag, commit);
  const published = (await host.releases(tag)).find(
    (release) => !release.draft,
  );
  if (!published) return "publish";
  const problems = await publishedProblems(host, tag, commit, published);
  if (problems.length)
    throw publicationError(
      `${tag} is published, but ${problems.join("; ")}.`,
      "A published release is never replaced, and a rebuild would not match its bytes. Check its files against its SHA256SUMS and attestations by hand; to change it, release a new version.",
      { release: published.id, problems },
    );
  return "published";
}

/** What is wrong with `draft` as the publication of `files`; empty when it holds exactly them, all uploaded with this
 * run's bytes. A digest the host does not report is computed from the downloaded asset, never skipped. */
export async function draftProblems(
  host: ReleaseHost,
  draft: HostedRelease,
  files: readonly ReleaseFile[],
): Promise<readonly string[]> {
  const problems: string[] = [];
  for (const file of files) {
    const asset = draft.assets.find(
      (candidate) => candidate.name === file.name,
    );
    if (!asset) problems.push(`${file.name} is missing`);
    else if (asset.state !== "uploaded")
      problems.push(`${file.name} is ${asset.state}, not uploaded`);
    else {
      const digest = await assetSha256(host, asset);
      if (digest !== file.sha256)
        problems.push(`${file.name} is ${digest}, not ${file.sha256}`);
    }
  }
  for (const asset of draft.assets)
    if (!files.some((file) => file.name === asset.name))
      problems.push(`${asset.name} is not part of the release`);
  return problems;
}

/** Publishes `files`, built from `commit`, as `tag` through a fresh draft, which is published only once it holds
 * exactly them. Drafts of `tag` left by an interrupted run are deleted first; a published release is never changed. */
export async function publishRelease(
  host: ReleaseHost,
  tag: string,
  commit: string,
  files: readonly ReleaseFile[],
): Promise<void> {
  if ((await releaseState(host, tag, commit)) === "published")
    throw publicationError(
      `${tag} is already published.`,
      "A published release is never replaced; nothing was changed. Release a new version to change it.",
    );
  for (const draft of (await host.releases(tag)).filter(
    (release) => release.draft,
  ))
    await host.remove(draft.id);
  await host.createDraft(tag, files);
  const drafts = (await host.releases(tag)).filter((release) => release.draft);
  const draft = drafts[0];
  if (!draft || drafts.length !== 1)
    throw publicationError(
      `Expected one draft of ${tag} after uploading it, found ${drafts.length}.`,
      "Another run may be publishing this tag. Let it finish, then re-run this one: it replaces any draft.",
    );
  const problems = await draftProblems(host, draft, files);
  if (problems.length)
    throw publicationError(
      `The draft of ${tag} is incomplete: ${problems.join("; ")}.`,
      "Nothing was published. Re-run the release: it replaces the draft.",
      { release: draft.id, problems },
    );
  await checkTag(host, tag, commit);
  await host.publish(draft.id);
}

/** What one gh run returned. */
export interface GhResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}
/** Runs gh with `args`. */
export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

const runGh: GhRunner = async (args) => {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

const releasePages = z.array(
  z.array(
    z.object({
      id: z.number(),
      tag_name: z.string(),
      draft: z.boolean(),
      assets: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          digest: z.string().nullish(),
          state: z.string(),
        }),
      ),
    }),
  ),
);
const commitResponse = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) });

/** The GitHub Releases of `repository` (owner/name), through gh. */
export function githubReleases(
  repository: string,
  gh: GhRunner = runGh,
): ReleaseHost {
  const releases = `repos/${repository}/releases`;
  /** Runs gh and resolves with its output, failing when it fails. */
  const run = async (args: readonly string[]) => {
    const result = await gh(args);
    if (result.code)
      throw publicationError(
        `gh ${args.slice(0, 2).join(" ")} failed (exit ${result.code}): ${result.stderr.trim()}`,
        "Check gh is signed in with write access to the repository's releases, then re-run.",
        { args },
      );
    return result.stdout;
  };
  const json = async (args: readonly string[]): Promise<unknown> =>
    JSON.parse(new TextDecoder().decode(await run(args)));
  return {
    async releases(tag) {
      const pages = releasePages.parse(
        await json([
          "api",
          "--paginate",
          "--slurp",
          `${releases}?per_page=100`,
        ]),
      );
      return pages
        .flat()
        .filter((release) => release.tag_name === tag)
        .map((release) => ({
          id: release.id,
          tag: release.tag_name,
          draft: release.draft,
          assets: release.assets.map((asset) => ({
            id: asset.id,
            name: asset.name,
            digest: asset.digest ?? null,
            state: asset.state,
          })),
        }));
    },
    async tagCommit(tag) {
      return commitResponse.parse(
        await json(["api", `repos/${repository}/commits/refs/tags/${tag}`]),
      ).sha;
    },
    async download(asset) {
      return await run([
        "api",
        "-H",
        "Accept: application/octet-stream",
        `${releases}/assets/${asset}`,
      ]);
    },
    async provenanceProblem(name, bytes, tag, commit) {
      const directory = await mkdtemp(join(tmpdir(), "rig-provenance-"));
      try {
        await writeFile(join(directory, name), bytes);
        const result = await gh([
          "attestation",
          "verify",
          join(directory, name),
          "--repo",
          repository,
          "--signer-workflow",
          `${repository}/.github/workflows/release.yml`,
          "--source-digest",
          commit,
          "--source-ref",
          `refs/tags/${tag}`,
        ]);
        return result.code
          ? result.stderr.trim() ||
              `gh attestation verify exited ${result.code}`
          : undefined;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async remove(id) {
      await run(["api", "--method", "DELETE", `${releases}/${id}`]);
    },
    async createDraft(tag, files) {
      await run([
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
      await run([
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
  const [command, tag, commit, dist] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  try {
    if (
      (command !== "status" && command !== "publish") ||
      !tag ||
      !commit ||
      !/^[0-9a-f]{40}$/.test(commit) ||
      !dist ||
      !repository
    )
      throw publicationError(
        "usage: bun scripts/publish-release.ts status|publish <tag> <commit> <dist>",
        "Give the full 40-character commit SHA, and set GITHUB_REPOSITORY to owner/name.",
      );
    const host = githubReleases(repository);
    const files = await readReleaseFiles(tag, dist);
    if (command === "status")
      process.stdout.write(`${await releaseState(host, tag, commit)}\n`);
    else {
      await publishRelease(host, tag, commit, files);
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
