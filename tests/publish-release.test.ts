import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  githubReleases,
  publishRelease,
  readReleaseFiles,
  releaseFileNames,
  releaseState,
  type HostedRelease,
  type ReleaseFile,
  type ReleaseHost,
} from "../scripts/publish-release";

const TAG = "v1.2.3";
const files: readonly ReleaseFile[] = releaseFileNames(TAG).map((name, i) => ({
  name,
  path: `/dist/${name}`,
  sha256: String(i).repeat(64),
}));
const uploaded = (file: ReleaseFile) => ({
  name: file.name,
  digest: `sha256:${file.sha256}`,
  state: "uploaded",
});

/** GitHub Releases in memory; `upload` decides which assets a created draft ends up with. */
function releasesHost(
  initial: readonly HostedRelease[],
  upload: (files: readonly ReleaseFile[]) => HostedRelease["assets"] = (all) =>
    all.map(uploaded),
) {
  let releases = [...initial];
  let next = 100;
  const calls: string[] = [];
  const host: ReleaseHost = {
    async releases(tag) {
      return releases.filter((release) => release.tag === tag);
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      releases = releases.filter((release) => release.id !== id);
    },
    async createDraft(tag, created) {
      calls.push(`create ${tag}`);
      releases.push({ id: next++, tag, draft: true, assets: upload(created) });
    },
    async publish(id) {
      calls.push(`publish ${id}`);
      releases = releases.map((release) =>
        release.id === id ? { ...release, draft: false } : release,
      );
    },
  };
  return { host, calls, releases: () => releases };
}

test("a tag with no release is published through a draft that holds every file", async () => {
  const github = releasesHost([]);
  expect(releaseState(TAG, await github.host.releases(TAG))).toBe("publish");
  await publishRelease(github.host, TAG, files);
  expect(github.calls).toEqual(["create v1.2.3", "publish 100"]);
  expect(github.releases()).toEqual([
    { id: 100, tag: TAG, draft: false, assets: files.map(uploaded) },
  ]);
});

test("a re-run replaces the drafts an interrupted run left, and leaves other tags' releases alone", async () => {
  const github = releasesHost([
    { id: 1, tag: TAG, draft: true, assets: [uploaded(files[0]!)] },
    { id: 2, tag: TAG, draft: true, assets: [] },
    { id: 3, tag: "v1.2.2", draft: true, assets: [] },
    { id: 4, tag: "v1.2.1", draft: false, assets: [] },
  ]);
  expect(releaseState(TAG, await github.host.releases(TAG))).toBe("publish");
  await publishRelease(github.host, TAG, files);
  expect(github.calls).toEqual([
    "remove 1",
    "remove 2",
    "create v1.2.3",
    "publish 100",
  ]);
  expect(github.releases().map((release) => release.id)).toEqual([3, 4, 100]);
});

test("a published release is never deleted or changed: a complete one reads as published, and publishing it again fails", async () => {
  const published = {
    id: 7,
    tag: TAG,
    draft: false,
    assets: files.map(uploaded),
  };
  const github = releasesHost([published]);
  expect(releaseState(TAG, await github.host.releases(TAG))).toBe("published");
  await expect(publishRelease(github.host, TAG, files)).rejects.toMatchObject({
    code: "RELEASE_PUBLICATION",
    message: "v1.2.3 is already published.",
  });
  expect(github.calls).toEqual([]);
  expect(github.releases()).toEqual([published]);
});

test("a published release missing a file fails rather than being replaced", async () => {
  const github = releasesHost([
    { id: 7, tag: TAG, draft: false, assets: files.slice(1).map(uploaded) },
  ]);
  expect(() => releaseState(TAG, github.releases())).toThrow(
    /v1\.2\.3 is published with .* not exactly SHA256SUMS, install/,
  );
  await expect(publishRelease(github.host, TAG, files)).rejects.toMatchObject({
    code: "RELEASE_PUBLICATION",
  });
  expect(github.calls).toEqual([]);
});

test("a draft missing a file, holding a different file or one still uploading stays a draft", async () => {
  const cases: Record<
    string,
    (all: readonly ReleaseFile[]) => HostedRelease["assets"]
  > = {
    missing: (all) => all.slice(1).map(uploaded),
    different: (all) =>
      all.map((file, i) =>
        i
          ? uploaded(file)
          : { ...uploaded(file), digest: `sha256:${"f".repeat(64)}` },
      ),
    uploading: (all) =>
      all.map((file, i) =>
        i ? uploaded(file) : { ...uploaded(file), state: "open" },
      ),
    extra: (all) => [
      ...all.map(uploaded),
      { name: "notes.txt", digest: null, state: "uploaded" },
    ],
  };
  for (const [name, upload] of Object.entries(cases)) {
    const github = releasesHost([], upload);
    await expect(
      publishRelease(github.host, TAG, files),
      name,
    ).rejects.toMatchObject({
      code: "RELEASE_PUBLICATION",
      message: expect.stringContaining("The draft of v1.2.3 is incomplete"),
    });
    expect(github.calls, name).toEqual(["create v1.2.3"]);
    expect(github.releases()[0]?.draft, name).toBe(true);
  }
});

test("the packaged directory must hold exactly the tag's files", async () => {
  const dist = await mkdtemp(join(tmpdir(), "rig-publish-"));
  try {
    for (const name of releaseFileNames(TAG))
      await writeFile(join(dist, name), name);
    const read = await readReleaseFiles(TAG, dist);
    expect(read.map((file) => file.name)).toEqual([...releaseFileNames(TAG)]);
    expect(read.find((file) => file.name === "install")?.sha256).toBe(
      new Bun.CryptoHasher("sha256").update("install").digest("hex"),
    );
    await writeFile(join(dist, "extra"), "");
    await expect(readReleaseFiles(TAG, dist)).rejects.toMatchObject({
      code: "RELEASE_PUBLICATION",
    });
    await expect(readReleaseFiles("v9.9.9", dist)).rejects.toMatchObject({
      code: "RELEASE_PUBLICATION",
    });
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test("GitHub releases go through gh: every page read, a draft created on the existing tag, published by id", async () => {
  const calls: (readonly string[])[] = [];
  const page = (id: number, tag: string, draft: boolean) => ({
    id,
    tag_name: tag,
    draft,
    assets: [{ name: "install", state: "uploaded", digest: null, size: 1 }],
  });
  const github = githubReleases("b-relay/rig", async (args) => {
    calls.push(args);
    return args[0] === "api" && args[1] === "--paginate"
      ? JSON.stringify([[page(1, "v1.2.2", false)], [page(2, TAG, true)]])
      : "";
  });
  expect(await github.releases(TAG)).toEqual([
    {
      id: 2,
      tag: TAG,
      draft: true,
      assets: [{ name: "install", state: "uploaded", digest: null }],
    },
  ]);
  await github.remove(2);
  await github.createDraft(TAG, files);
  await github.publish(3);
  expect(calls).toEqual([
    ["api", "--paginate", "--slurp", "repos/b-relay/rig/releases?per_page=100"],
    ["api", "--method", "DELETE", "repos/b-relay/rig/releases/2"],
    [
      "release",
      "create",
      TAG,
      ...files.map((file) => file.path),
      "--repo",
      "b-relay/rig",
      "--draft",
      "--verify-tag",
      "--title",
      "Rig v1.2.3",
      "--generate-notes",
    ],
    [
      "api",
      "--method",
      "PATCH",
      "repos/b-relay/rig/releases/3",
      "-F",
      "draft=false",
    ],
  ]);
});
