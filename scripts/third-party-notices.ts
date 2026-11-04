/** Writes THIRD_PARTY_NOTICES into an assembled dashboard, so a release carries the license of every third-party package
 * it bundles, in the archive and once installed. scripts/package-release.sh runs it:
 *
 *   bun scripts/third-party-notices.ts <dashboard>
 *
 * The packages are read from node_modules, never listed here: the production dependencies with everything they depend on
 * (Next.js compiles the dashboard's into its chunks, which name no package) and whatever else the dashboard's own
 * node_modules holds. It fails when one has no license file, so a release cannot ship without its notice. Code embedded in
 * a vendored bundle has no license file to find, so what is known of it is listed in EMBEDDED_NOTICES. */
import { readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { errorMessage, RigError } from "../src/domain/errors";

export const NOTICES_FILE = "THIRD_PARTY_NOTICES";

/** A package installed in a node_modules directory. */
export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  /** The SPDX expression its package.json declares, when it declares one. */
  readonly license?: string;
  readonly dependencies: readonly string[];
  readonly directory: string;
}

/** What stands in for a license file in the few packages published without one. Rendering fails when an entry is no
 * longer needed, so this cannot go stale. */
export const NO_LICENSE_FILE: Readonly<Record<string, string>> = {
  "@next/env":
    "Part of Next.js and published without a license file of its own: see the license of next in this file.",
  "client-only":
    "Declared MIT in its package.json; published with no license file and no copyright line.",
  "react-remove-scroll-bar": `MIT License

Copyright (c) 2025 Anton Korzunov <thekashey@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
};

/** Code embedded in a file a package vendors, whose license no file there holds. */
export interface EmbeddedNotice {
  /** What is embedded. */
  readonly name: string;
  /** The package that vendors it. */
  readonly package: string;
  /** The file holding it, relative to the package. */
  readonly file: string;
  /** Text that file contains for as long as it embeds it. */
  readonly marker: string;
  readonly notice: string;
}

/** Notices of embedded code that license files miss. Rendering fails when an entry's file no longer embeds it, so this
 * cannot go stale. */
export const EMBEDDED_NOTICES: readonly EmbeddedNotice[] = [
  {
    name: "undici",
    package: "next",
    file: "dist/compiled/@edge-runtime/primitives/load.js",
    marker: "node_modules/undici/",
    notice: `MIT License

Copyright (c) Matteo Collina and Undici contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  },
];

const LICENSE_FILE =
  /^(licen[cs]e|copying|notice)(-[\w.-]+)?(\.(md|markdown|txt))?$/i;
const SEPARATOR = "=".repeat(80);

const Manifest = z.object({
  name: z.string(),
  version: z.string(),
  license: z.unknown().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
});

const noticesError = (
  message: string,
  hint: string,
  details: Record<string, unknown> = {},
) => new RigError("RELEASE_NOTICES", message, hint, details);

const label = (found: Pick<InstalledPackage, "name" | "version">) =>
  `${found.name}@${found.version}`;

async function readPackage(
  directory: string,
): Promise<InstalledPackage | undefined> {
  const file = Bun.file(join(directory, "package.json"));
  if (!(await file.exists())) return undefined;
  const manifest = Manifest.parse(await file.json());
  return {
    name: manifest.name,
    version: manifest.version,
    ...(typeof manifest.license === "string"
      ? { license: manifest.license }
      : {}),
    dependencies: Object.keys(manifest.dependencies ?? {}),
    directory,
  };
}

/** Every package under a node_modules directory, those nested inside another package's included. */
async function installedPackages(
  nodeModules: string,
): Promise<InstalledPackage[]> {
  const names = await readdir(nodeModules).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const directories = (
    await Promise.all(
      names
        .filter((name) => !name.startsWith("."))
        .map(async (name) =>
          name.startsWith("@")
            ? (await readdir(join(nodeModules, name))).map((scoped) =>
                join(nodeModules, name, scoped),
              )
            : [join(nodeModules, name)],
        ),
    )
  ).flat();
  const found = await Promise.all(
    directories.map(async (directory) => {
      const installed = await readPackage(directory);
      return installed
        ? [
            installed,
            ...(await installedPackages(join(directory, "node_modules"))),
          ]
        : [];
    }),
  );
  return found.flat();
}

/** `root`'s production dependencies and everything they depend on, as each resolves from where it is installed. Optional
 * dependencies are left out: they are other platforms' native builds, which depend on the Mac that installs them. */
export async function productionPackages(
  root: string,
): Promise<InstalledPackage[]> {
  const found = new Map<string, InstalledPackage>();
  const resolve = async (from: string, name: string) => {
    for (let directory = from; ; directory = dirname(directory)) {
      const dependency = await readPackage(
        join(directory, "node_modules", name),
      );
      if (dependency || directory === root) return dependency;
    }
  };
  const visit = async (from: string, dependencies: readonly string[]) => {
    for (const name of dependencies) {
      const dependency = await resolve(from, name);
      if (!dependency)
        throw noticesError(
          `${name}, a production dependency needed by ${from}, is not in node_modules, so its license cannot be read.`,
          "Run bun install --frozen-lockfile, then package again.",
          { name, from },
        );
      if (found.has(dependency.directory)) continue;
      found.set(dependency.directory, dependency);
      await visit(dependency.directory, dependency.dependencies);
    }
  };
  const manifest = Manifest.pick({ dependencies: true }).parse(
    await Bun.file(join(root, "package.json")).json(),
  );
  await visit(root, Object.keys(manifest.dependencies ?? {}));
  return [...found.values()];
}

/** Every package a release bundles, each once, by name and version, read from `root`'s node_modules: the assembled
 * dashboard's own copies have lost their license files. */
export async function releasePackages(
  root: string,
  dashboard: string,
): Promise<InstalledPackage[]> {
  const packages = new Map(
    (await productionPackages(root)).map((found) => [label(found), found]),
  );
  const installed = new Map(
    (await installedPackages(join(root, "node_modules"))).map((found) => [
      label(found),
      found,
    ]),
  );
  for (const shipped of await installedPackages(
    join(dashboard, "node_modules"),
  )) {
    const source = installed.get(label(shipped));
    if (!source)
      throw noticesError(
        `The dashboard carries ${label(shipped)}, which is not in node_modules, so its license cannot be read.`,
        "Run bun install --frozen-lockfile, then build the dashboard and package again.",
        { package: label(shipped) },
      );
    packages.set(label(shipped), source);
  }
  return [...packages.values()];
}

/** The license files a package publishes, relative to it: its own, and those of code vendored inside it (Next.js's
 * dist/compiled). */
async function licenseFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob("**/*").scan({ cwd: directory })) {
    if (LICENSE_FILE.test(basename(path)) && !path.includes("node_modules/"))
      files.push(path);
  }
  return files.sort();
}

/** Whether `entry` still describes what the package `found` holds. */
async function stillEmbedded(found: InstalledPackage, entry: EmbeddedNotice) {
  const file = Bun.file(join(found.directory, entry.file));
  return (await file.exists()) && (await file.text()).includes(entry.marker);
}

/** The text of the notices file. Fails naming every package with neither a license file of its own nor a stand-in, every
 * stand-in no longer needed, and every embedded notice whose file no longer embeds its code. */
export async function renderNotices(
  packages: readonly InstalledPackage[],
  standIns: Readonly<Record<string, string>> = NO_LICENSE_FILE,
  embedded: readonly EmbeddedNotice[] = EMBEDDED_NOTICES,
): Promise<string> {
  const sorted = [...packages].sort((a, b) =>
    label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0,
  );
  const missing: string[] = [];
  const stale = Object.keys(standIns).filter(
    (name) => !sorted.some((found) => found.name === name),
  );
  const staleEmbedded = embedded.filter(
    (entry) => !sorted.some((found) => found.name === entry.package),
  );
  const sections: string[] = [];
  for (const found of sorted) {
    const files = await licenseFiles(found.directory);
    const hasOwn = files.some((file) => !file.includes("/"));
    const standIn = standIns[found.name];
    if (!hasOwn && standIn === undefined) missing.push(label(found));
    if (hasOwn && standIn !== undefined) stale.push(found.name);
    const texts = await Promise.all(
      files.map(async (file) => {
        const text = (
          await Bun.file(join(found.directory, file)).text()
        ).trimEnd();
        return file.includes("/") ? `--- ${file} ---\n\n${text}` : text;
      }),
    );
    const embeddedTexts: string[] = [];
    for (const entry of embedded.filter(
      (each) => each.package === found.name,
    )) {
      if (await stillEmbedded(found, entry))
        embeddedTexts.push(
          `--- ${entry.name}, embedded in ${entry.file} ---\n\n${entry.notice}`,
        );
      else staleEmbedded.push(entry);
    }
    const declared = found.license ? ` (${found.license})` : "";
    sections.push(
      [
        `${SEPARATOR}\n${label(found)}${declared}\n${SEPARATOR}`,
        ...(hasOwn ? [] : [standIn]),
        ...texts,
        ...embeddedTexts,
      ].join("\n\n"),
    );
  }
  if (missing.length > 0)
    throw noticesError(
      `A release cannot carry these packages without their license: ${missing.join(", ")} publish no license file.`,
      "Find the package's license upstream and add it to NO_LICENSE_FILE in scripts/third-party-notices.ts, or drop the dependency.",
      { missing },
    );
  if (stale.length > 0)
    throw noticesError(
      `NO_LICENSE_FILE has entries no longer needed: ${stale.join(", ")}.`,
      "Remove them from scripts/third-party-notices.ts: the release no longer bundles them, or they now publish a license file.",
      { stale },
    );
  if (staleEmbedded.length > 0) {
    const names = staleEmbedded.map(
      (entry) => `${entry.name} in ${entry.package}'s ${entry.file}`,
    );
    throw noticesError(
      `EMBEDDED_NOTICES has entries no longer true: ${names.join(", ")}.`,
      "Check where that code went: update the entry's file and marker if it moved, or remove the entry from scripts/third-party-notices.ts if it is gone.",
      { stale: names },
    );
  }
  return `Rig bundles the third-party packages below. Each one's license follows its name.\n\n${sections.join("\n\n")}\n`;
}

if (import.meta.main) {
  const [dashboard, ...rest] = process.argv.slice(2);
  try {
    if (!dashboard || rest.length > 0)
      throw noticesError(
        "usage: bun scripts/third-party-notices.ts <dashboard>",
        "Give the directory scripts/build-dashboard.sh assembled.",
      );
    const packages = await releasePackages(
      join(import.meta.dir, ".."),
      dashboard,
    );
    await writeFile(
      join(dashboard, NOTICES_FILE),
      await renderNotices(packages),
    );
    process.stdout.write(
      `Wrote the notices of ${packages.length} packages to ${join(dashboard, NOTICES_FILE)}.\n`,
    );
  } catch (error) {
    const hint = error instanceof RigError ? `\n${error.hint}` : "";
    process.stderr.write(
      `third-party-notices: ${errorMessage(error)}${hint}\n`,
    );
    process.exit(1);
  }
}
