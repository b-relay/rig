import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  productionPackages,
  releasePackages,
  renderNotices,
} from "../scripts/third-party-notices";

const REPOSITORY = join(import.meta.dir, "..");
let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "rig-notices-test-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Writes `files`, by path, under a fresh directory. */
async function tree(files: Record<string, string | object>): Promise<string> {
  const root = await mkdtemp(join(base, "tree-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

const manifest = (
  name: string,
  dependencies: Record<string, string> = {},
  more: object = {},
) => ({ name, version: "1.0.0", license: "MIT", dependencies, ...more });

test("the notices hold the license of each production dependency and what it depends on, and nothing that is not one", async () => {
  const root = await tree({
    "package.json": {
      ...manifest("app", { first: "1" }),
      devDependencies: { tool: "1" },
    },
    "node_modules/first/package.json": manifest(
      "first",
      { "@scope/second": "1", third: "1" },
      { optionalDependencies: { native: "1" } },
    ),
    "node_modules/first/LICENSE": "first's license\n",
    "node_modules/first/dist/compiled/vendored/LICENSE": "vendored license\n",
    "node_modules/first/node_modules/third/package.json": manifest("third"),
    "node_modules/first/node_modules/third/license.md": "nested third license",
    "node_modules/third/package.json": manifest("third", {}, { version: "9" }),
    "node_modules/third/license.md": "hoisted third license",
    "node_modules/@scope/second/package.json": manifest("@scope/second"),
    "node_modules/@scope/second/LICENCE.txt": "second's licence",
    "node_modules/native/package.json": manifest("native"),
    "node_modules/native/LICENSE": "native license",
    "node_modules/tool/package.json": manifest("tool"),
    "node_modules/tool/LICENSE": "tool license",
  });
  const dashboard = await tree({});
  const notices = await renderNotices(
    await releasePackages(root, dashboard),
    {},
    [],
  );
  expect(notices).toContain("first@1.0.0 (MIT)");
  expect(notices).toContain("first's license");
  expect(notices).toContain(
    "--- dist/compiled/vendored/LICENSE ---\n\nvendored license",
  );
  expect(notices).toContain("@scope/second@1.0.0 (MIT)");
  expect(notices).toContain("second's licence");
  // first resolves its own nested copy, not the hoisted one.
  expect(notices).toContain("nested third license");
  expect(notices).not.toContain("hoisted third license");
  expect(notices).not.toContain("native");
  expect(notices).not.toContain("tool");
});

test("a package only the dashboard's node_modules holds gets its notice from the repository's copy, and one found nowhere fails", async () => {
  const root = await tree({
    "package.json": manifest("app"),
    "node_modules/traced/package.json": manifest("traced"),
    "node_modules/traced/LICENSE": "traced license",
  });
  const dashboard = await tree({
    "node_modules/traced/package.json": manifest("traced"),
  });
  const notices = await renderNotices(
    await releasePackages(root, dashboard),
    {},
    [],
  );
  expect(notices).toContain("traced@1.0.0 (MIT)");
  expect(notices).toContain("traced license");

  const unknown = await tree({
    "node_modules/other/package.json": manifest("other"),
  });
  await expect(releasePackages(root, unknown)).rejects.toThrow(
    "The dashboard carries other@1.0.0, which is not in node_modules",
  );
});

test("a bundled package with no license file of its own fails, naming every one, even with a vendored license inside it", async () => {
  const root = await tree({
    "package.json": manifest("app", { good: "1", bare: "1", vendors: "1" }),
    "node_modules/good/package.json": manifest("good"),
    "node_modules/good/LICENSE": "good license",
    "node_modules/bare/package.json": manifest("bare"),
    "node_modules/bare/README.md": "MIT, it says",
    "node_modules/vendors/package.json": manifest("vendors"),
    "node_modules/vendors/dist/compiled/other/LICENSE": "another's license",
  });
  const packages = await productionPackages(root);
  await expect(renderNotices(packages, {}, [])).rejects.toThrow(
    "bare@1.0.0, vendors@1.0.0 publish no license file.",
  );
});

test("a production dependency that is not installed fails rather than dropping its notice", async () => {
  const root = await tree({ "package.json": manifest("app", { gone: "1" }) });
  await expect(productionPackages(root)).rejects.toThrow(
    "gone, a production dependency needed by",
  );
});

test("a stand-in serves a package published without a license file, and fails once it is no longer needed", async () => {
  const root = await tree({
    "package.json": manifest("app", { bare: "1", licensed: "1" }),
    "node_modules/bare/package.json": manifest("bare"),
    "node_modules/licensed/package.json": manifest("licensed"),
    "node_modules/licensed/LICENSE": "licensed license",
  });
  const packages = await productionPackages(root);
  expect(
    await renderNotices(packages, { bare: "bare's stand-in" }, []),
  ).toContain("bare's stand-in");
  await expect(
    renderNotices(packages, { bare: "text", licensed: "text" }, []),
  ).rejects.toThrow("no longer needed: licensed.");
  await expect(
    renderNotices(packages, { bare: "text", removed: "text" }, []),
  ).rejects.toThrow("no longer needed: removed.");
});

test("an embedded notice goes in its package's section, and fails once its file no longer embeds the code or is gone", async () => {
  const root = await tree({
    "package.json": manifest("app", { host: "1" }),
    "node_modules/host/package.json": manifest("host"),
    "node_modules/host/LICENSE": "host license",
    "node_modules/host/bundle.js": "// from node_modules/guest/index.js",
    "node_modules/host/plain.js": "// nothing embedded",
  });
  const packages = await productionPackages(root);
  const entry = {
    name: "guest",
    package: "host",
    file: "bundle.js",
    marker: "node_modules/guest/",
    notice: "guest's notice",
  };
  expect(await renderNotices(packages, {}, [entry])).toContain(
    "--- guest, embedded in bundle.js ---\n\nguest's notice",
  );
  const stale = "EMBEDDED_NOTICES has entries no longer true: guest in host's";
  await expect(
    renderNotices(packages, {}, [{ ...entry, file: "plain.js" }]),
  ).rejects.toThrow(`${stale} plain.js.`);
  await expect(
    renderNotices(packages, {}, [{ ...entry, file: "gone.js" }]),
  ).rejects.toThrow(`${stale} gone.js.`);
  await expect(
    renderNotices(packages, {}, [{ ...entry, package: "other" }]),
  ).rejects.toThrow("guest in other's bundle.js.");
});

test("this repository's production dependencies all have a notice, with the license text of what rig, rigd and the dashboard bundle", async () => {
  const notices = await renderNotices(await productionPackages(REPOSITORY));
  for (const name of [
    "tldts",
    "tldts-core",
    "zod",
    "commander",
    "yaml",
    "next",
    "react",
    "react-dom",
    "lucide-react",
    "@radix-ui/react-dialog",
  ]) {
    const section = notices.split(new RegExp(`^${name}@.*$`, "m"))[1];
    expect(section, `no notice for ${name}`).toBeDefined();
    expect(section!.split("=".repeat(80))[1]).toMatch(/copyright|ISC/i);
  }
  expect(notices).not.toContain("sharp@");
});

test("every license file vendored under next's dist/compiled is in the notices, under its path, with its text", async () => {
  const next = join(REPOSITORY, "node_modules/next");
  const vendored: string[] = [];
  for await (const path of new Bun.Glob("dist/compiled/**/*").scan({
    cwd: next,
  })) {
    if (/^licen[cs]e/i.test(basename(path))) vendored.push(path);
  }
  expect(vendored).toContain("dist/compiled/busboy/LICENSE");
  const notices = await renderNotices(await productionPackages(REPOSITORY));
  const absent: string[] = [];
  for (const path of vendored) {
    const text = (await Bun.file(join(next, path)).text()).trimEnd();
    if (!notices.includes(`--- ${path} ---\n\n${text}`)) absent.push(path);
  }
  expect(absent).toEqual([]);
});

test("Undici's notice, for the copy embedded in a bundle next vendors with no license file of its own, is in the notices", async () => {
  const notices = await renderNotices(await productionPackages(REPOSITORY));
  const next = notices.split(/^next@.*$/m)[1]!.split("=".repeat(80))[1]!;
  expect(next).toContain(
    "--- undici, embedded in dist/compiled/@edge-runtime/primitives/load.js ---\n\nMIT License\n\nCopyright (c) Matteo Collina and Undici contributors",
  );
});

test("everything rig and rigd bundle is a production dependency, so the notices cover it", async () => {
  const production = new Set(
    (await productionPackages(REPOSITORY)).map((found) => found.name),
  );
  const build = await Bun.build({
    entrypoints: [
      join(REPOSITORY, "src/index.ts"),
      join(REPOSITORY, "src/rigd.ts"),
    ],
    target: "bun",
    metafile: true,
  });
  const bundled = new Set(
    Object.keys(build.metafile?.inputs ?? {}).flatMap(
      (input) =>
        input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/[^/]/)?.[1] ?? [],
    ),
  );
  expect([...bundled]).toContain("tldts");
  expect([...bundled]).toContain("zod");
  expect([...bundled].filter((name) => !production.has(name))).toEqual([]);
});
