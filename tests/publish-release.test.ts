import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  githubReleases,
  publishRelease,
  readReleaseFiles,
  releaseFileNames,
  releaseState,
  type GhResult,
  type HostedAsset,
  type HostedRelease,
  type ReleaseFile,
  type ReleaseHost,
} from "../scripts/publish-release";

const TAG = "v1.2.3";
const COMMIT = "a".repeat(40);
const hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (text: string) => new TextEncoder().encode(text);

/** This run's packaged files: three of them, and a SHA256SUMS listing them. */
const built = new Map<string, Uint8Array>(
  releaseFileNames(TAG)
    .filter((name) => name !== "SHA256SUMS")
    .map((name) => [name, encode(`${name} as built`)]),
);
built.set(
  "SHA256SUMS",
  encode(
    [...built].map(([name, bytes]) => `${hex(bytes)}  ${name}\n`).join(""),
  ),
);
const files: readonly ReleaseFile[] = releaseFileNames(TAG).map((name) => ({
  name,
  path: `/dist/${name}`,
  sha256: hex(built.get(name)!),
}));

/** One asset as uploaded: its bytes, the digest the host reports (its own SHA-256 unless given; null for none), and
 * its state. */
interface Upload {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly digest?: string | null;
  readonly state?: string;
}
const uploads = (
  change: (name: string) => Partial<Upload> = () => ({}),
): Upload[] =>
  [...built].map(([name, bytes]) => ({ name, bytes, ...change(name) }));

/** GitHub Releases in memory: `upload` decides what a created draft ends up holding, `provenance` what attestation
 * verification says. */
function releasesHost(
  initial: readonly {
    id: number;
    tag: string;
    draft: boolean;
    assets: Upload[];
  }[],
  options: {
    upload?: () => Upload[];
    tagCommit?: string;
    provenance?: string;
  } = {},
) {
  const blobs = new Map<number, Uint8Array>();
  const names = new Map<number, string>();
  let next = 1000;
  const asset = (upload: Upload): HostedAsset => {
    const id = next++;
    blobs.set(id, upload.bytes);
    names.set(id, upload.name);
    return {
      id,
      name: upload.name,
      digest:
        upload.digest === undefined
          ? `sha256:${hex(upload.bytes)}`
          : upload.digest,
      state: upload.state ?? "uploaded",
    };
  };
  let releases: HostedRelease[] = initial.map((release) => ({
    ...release,
    assets: release.assets.map(asset),
  }));
  const calls: string[] = [];
  const attested: string[] = [];
  const host: ReleaseHost = {
    async releases(tag) {
      return releases.filter((release) => release.tag === tag);
    },
    async tagCommit() {
      return options.tagCommit ?? COMMIT;
    },
    async download(id) {
      calls.push(`download ${names.get(id)}`);
      return blobs.get(id)!;
    },
    async provenanceProblem(name, bytes, tag, commit) {
      attested.push(`${name} ${hex(bytes)} ${tag} ${commit}`);
      return options.provenance;
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      releases = releases.filter((release) => release.id !== id);
    },
    async createDraft(tag) {
      calls.push(`create ${tag}`);
      const assets = (options.upload ?? uploads)().map(asset);
      releases.push({ id: next++, tag, draft: true, assets });
    },
    async publish(id) {
      calls.push(`publish ${id}`);
      releases = releases.map((release) =>
        release.id === id ? { ...release, draft: false } : release,
      );
    },
  };
  return {
    host,
    calls,
    attested,
    mutations: () => calls.filter((call) => !call.startsWith("download")),
    releases: () => releases,
  };
}

test("a tag with no release is published through a draft that holds every file", async () => {
  const github = releasesHost([]);
  expect(await releaseState(github.host, TAG, COMMIT)).toBe("publish");
  await publishRelease(github.host, TAG, COMMIT, files);
  expect(github.calls).toEqual(["create v1.2.3", "publish 1004"]);
  expect(github.releases()).toMatchObject([
    { id: 1004, tag: TAG, draft: false },
  ]);
});

test("a re-run replaces the drafts an interrupted run left, and leaves other tags' releases alone", async () => {
  const github = releasesHost([
    { id: 1, tag: TAG, draft: true, assets: uploads().slice(0, 1) },
    { id: 2, tag: TAG, draft: true, assets: [] },
    { id: 3, tag: "v1.2.2", draft: true, assets: [] },
    { id: 4, tag: "v1.2.1", draft: false, assets: [] },
  ]);
  expect(await releaseState(github.host, TAG, COMMIT)).toBe("publish");
  await publishRelease(github.host, TAG, COMMIT, files);
  expect(github.calls).toEqual([
    "remove 1",
    "remove 2",
    "create v1.2.3",
    "publish 1005",
  ]);
  expect(github.releases().map((release) => release.id)).toEqual([3, 4, 1005]);
});

test("a complete published release reads as published, after its files are checked against its SHA256SUMS and its provenance", async () => {
  const github = releasesHost([
    { id: 7, tag: TAG, draft: false, assets: uploads() },
  ]);
  expect(await releaseState(github.host, TAG, COMMIT)).toBe("published");
  expect(github.attested).toEqual([
    `SHA256SUMS ${hex(built.get("SHA256SUMS")!)} ${TAG} ${COMMIT}`,
  ]);
  await expect(
    publishRelease(github.host, TAG, COMMIT, files),
  ).rejects.toMatchObject({
    code: "RELEASE_PUBLICATION",
    message: "v1.2.3 is already published.",
  });
  expect(github.mutations()).toEqual([]);
});

test("a published release whose host reports no digests is checked from its downloaded files", async () => {
  const github = releasesHost([
    {
      id: 7,
      tag: TAG,
      draft: false,
      assets: uploads(() => ({ digest: null })),
    },
  ]);
  expect(await releaseState(github.host, TAG, COMMIT)).toBe("published");
  expect([...new Set(github.calls)].sort()).toEqual(
    releaseFileNames(TAG).map((name) => `download ${name}`),
  );
});

test("a published release that is not exactly what its SHA256SUMS and provenance say fails, and is never changed", async () => {
  const other = encode("other bytes");
  const cases: Record<
    string,
    { assets: Upload[]; provenance?: string; error: string }
  > = {
    "a missing file": {
      assets: uploads().filter((upload) => upload.name !== "install"),
      error: "not exactly SHA256SUMS, install",
    },
    "a file another than SHA256SUMS lists": {
      assets: uploads((name) => (name === "install" ? { bytes: other } : {})),
      error: `install is ${hex(other)}, not ${hex(built.get("install")!)} as its SHA256SUMS lists`,
    },
    "a file another than SHA256SUMS lists, with no digest reported": {
      assets: uploads((name) =>
        name === "install" ? { bytes: other, digest: null } : {},
      ),
      error: `install is ${hex(other)}, not`,
    },
    "a SHA256SUMS listing other files": {
      assets: uploads((name) =>
        name === "SHA256SUMS"
          ? { bytes: encode(`${"0".repeat(64)}  install\n`) }
          : {},
      ),
      error: "its SHA256SUMS does not list exactly install",
    },
    "a SHA256SUMS other than the host's digest of it": {
      assets: uploads((name) =>
        name === "SHA256SUMS" ? { digest: `sha256:${"0".repeat(64)}` } : {},
      ),
      error: "its SHA256SUMS does not match the digest GitHub reports for it",
    },
    "no provenance for this commit": {
      assets: uploads(),
      provenance: "no matching attestation",
      error: `its SHA256SUMS has no provenance for ${COMMIT}: no matching attestation`,
    },
  };
  for (const [name, { assets, provenance, error }] of Object.entries(cases)) {
    const github = releasesHost([{ id: 7, tag: TAG, draft: false, assets }], {
      provenance,
    });
    await expect(
      releaseState(github.host, TAG, COMMIT),
      name,
    ).rejects.toMatchObject({
      code: "RELEASE_PUBLICATION",
      message: expect.stringContaining(error),
    });
    await expect(
      publishRelease(github.host, TAG, COMMIT, files),
      name,
    ).rejects.toMatchObject({ code: "RELEASE_PUBLICATION" });
    expect(github.mutations(), name).toEqual([]);
  }
});

test("a tag that no longer names the commit this run built is neither read as published nor published", async () => {
  const moved = "b".repeat(40);
  for (const initial of [
    [],
    [{ id: 7, tag: TAG, draft: false, assets: uploads() }],
  ]) {
    const github = releasesHost(initial, { tagCommit: moved });
    await expect(releaseState(github.host, TAG, COMMIT)).rejects.toMatchObject({
      message: `v1.2.3 now names ${moved}, not ${COMMIT}, the commit this run built.`,
    });
    await expect(
      publishRelease(github.host, TAG, COMMIT, files),
    ).rejects.toMatchObject({
      code: "RELEASE_PUBLICATION",
    });
    expect(github.mutations()).toEqual([]);
  }
});

test("a draft missing a file, holding other bytes, still uploading or holding an extra file stays a draft", async () => {
  const other = encode("other bytes");
  const cases: Record<string, () => Upload[]> = {
    missing: () => uploads().slice(1),
    "other bytes": () =>
      uploads((name) => (name === "install" ? { bytes: other } : {})),
    "other bytes, with no digest reported": () =>
      uploads((name) =>
        name === "install" ? { bytes: other, digest: null } : {},
      ),
    uploading: () =>
      uploads((name) => (name === "install" ? { state: "open" } : {})),
    extra: () => [...uploads(), { name: "notes.txt", bytes: other }],
  };
  for (const [name, upload] of Object.entries(cases)) {
    const github = releasesHost([], { upload });
    await expect(
      publishRelease(github.host, TAG, COMMIT, files),
      name,
    ).rejects.toMatchObject({
      code: "RELEASE_PUBLICATION",
      message: expect.stringContaining("The draft of v1.2.3 is incomplete"),
    });
    expect(github.mutations(), name).toEqual(["create v1.2.3"]);
    expect(github.releases()[0]?.draft, name).toBe(true);
  }
});

test("a draft whose host reports no digests is published once its downloaded files match", async () => {
  const github = releasesHost([], {
    upload: () => uploads(() => ({ digest: null })),
  });
  await publishRelease(github.host, TAG, COMMIT, files);
  expect(
    github.calls.filter((call) => call.startsWith("download")).sort(),
  ).toEqual(releaseFileNames(TAG).map((name) => `download ${name}`));
  expect(github.releases()[0]?.draft).toBe(false);
});

test("the packaged directory must hold exactly the tag's files", async () => {
  const dist = await mkdtemp(join(tmpdir(), "rig-publish-"));
  try {
    for (const name of releaseFileNames(TAG))
      await writeFile(join(dist, name), name);
    const read = await readReleaseFiles(TAG, dist);
    expect(read.map((file) => file.name)).toEqual([...releaseFileNames(TAG)]);
    expect(read.find((file) => file.name === "install")?.sha256).toBe(
      hex(encode("install")),
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

test("GitHub releases go through gh: every page read, the tag's commit, asset bytes, provenance, a draft on the existing tag, published by id", async () => {
  const calls: (readonly string[])[] = [];
  const page = (id: number, tag: string, draft: boolean) => ({
    id,
    tag_name: tag,
    draft,
    assets: [
      { id: 5, name: "install", state: "uploaded", digest: null, size: 1 },
    ],
  });
  const ok = (stdout: string): GhResult => ({
    code: 0,
    stdout: encode(stdout),
    stderr: "",
  });
  const github = githubReleases("b-relay/rig", async (args) => {
    calls.push(args);
    if (args[1] === "--paginate")
      return ok(
        JSON.stringify([[page(1, "v1.2.2", false)], [page(2, TAG, true)]]),
      );
    if (args[1]?.includes("/commits/"))
      return ok(JSON.stringify({ sha: COMMIT }));
    if (args[0] === "attestation")
      return {
        code: 1,
        stdout: new Uint8Array(),
        stderr: "no attestations found\n",
      };
    return ok("asset bytes");
  });
  expect(await github.releases(TAG)).toEqual([
    {
      id: 2,
      tag: TAG,
      draft: true,
      assets: [{ id: 5, name: "install", state: "uploaded", digest: null }],
    },
  ]);
  expect(await github.tagCommit(TAG)).toBe(COMMIT);
  expect(new TextDecoder().decode(await github.download(5))).toBe(
    "asset bytes",
  );
  expect(
    await github.provenanceProblem("SHA256SUMS", encode("sums"), TAG, COMMIT),
  ).toBe("no attestations found");
  await github.remove(2);
  await github.createDraft(TAG, files);
  await github.publish(3);
  const verified = calls.find((args) => args[0] === "attestation")!;
  expect(verified[2]).toEndWith("/SHA256SUMS");
  expect(
    calls.map((args) =>
      args === verified ? [...args.slice(0, 2), ...args.slice(3)] : args,
    ),
  ).toEqual([
    ["api", "--paginate", "--slurp", "repos/b-relay/rig/releases?per_page=100"],
    ["api", `repos/b-relay/rig/commits/refs/tags/${TAG}`],
    [
      "api",
      "-H",
      "Accept: application/octet-stream",
      "repos/b-relay/rig/releases/assets/5",
    ],
    [
      "attestation",
      "verify",
      "--repo",
      "b-relay/rig",
      "--signer-workflow",
      "b-relay/rig/.github/workflows/release.yml",
      "--source-digest",
      COMMIT,
      "--source-ref",
      `refs/tags/${TAG}`,
    ],
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
  const failing = githubReleases("b-relay/rig", async () => ({
    code: 1,
    stdout: new Uint8Array(),
    stderr: "HTTP 404",
  }));
  await expect(failing.tagCommit(TAG)).rejects.toMatchObject({
    code: "RELEASE_PUBLICATION",
    message:
      "gh api repos/b-relay/rig/commits/refs/tags/v1.2.3 failed (exit 1): HTTP 404",
  });
});
