import { join, relative } from "node:path";
import { API, type Checker, type Program } from "typescript/unstable/async";
import type { SourceFile } from "typescript/unstable/ast";

/** Files under src/ and web/ that are not Rig's production code, so the source checks do not read them. */
export const EXCLUDED: readonly {
  matches: (file: string) => boolean;
  why: string;
}[] = [
  {
    matches: (file) => /\.test\.tsx?$/.test(file),
    why: "Tests, which throw to fail and read their own fixtures.",
  },
  {
    matches: (file) => file.startsWith("web/demo/"),
    why: "Sample Projects the dashboard's demo mode deploys; they are its users' code, not Rig's.",
  },
  {
    matches: (file) => file === "web/postcss.config.mjs",
    why: "Build tooling for the dashboard's CSS.",
  },
];
export const excluded = (file: string) =>
  EXCLUDED.some(({ matches }) => matches(file));

/** Every production file under `src/` and `web/` of `root`, each read once with the type checker of the first TypeScript
 * project that holds it: `tsconfig.json`, then `web/tsconfig.json` when present. TypeScript 7 offers its checker only
 * through its unstable API; package.json pins that version. A file `skip` names is not read. Returns the files read. */
export async function readProductionFiles(
  root: string,
  skip: (file: string) => boolean,
  read: (
    source: SourceFile,
    file: string,
    project: { readonly program: Program; readonly checker: Checker },
  ) => Promise<void>,
): Promise<string[]> {
  const api = new API({ cwd: root });
  try {
    const projects = [join(root, "tsconfig.json")];
    if (await Bun.file(join(root, "web", "tsconfig.json")).exists())
      projects.push(join(root, "web", "tsconfig.json"));
    const snapshot = await api.updateSnapshot({ openProjects: projects });
    const files = new Set<string>();
    for (const project of snapshot.getProjects()) {
      for (const name of await project.program.getSourceFileNames()) {
        const file = relative(root, name);
        if (
          files.has(file) ||
          !/^(src|web)\//.test(file) ||
          file.includes("node_modules/") ||
          skip(file)
        )
          continue;
        const source = await project.program.getSourceFile(name);
        if (!source)
          throw new Error(`TypeScript gave no syntax tree for ${file}.`);
        files.add(file);
        await read(source, file, project);
      }
    }
    return [...files].sort();
  } finally {
    await api.close();
  }
}

/** Every tracked `.ts`, `.tsx`, `.js` and `.mjs` file under src/ and web/ of `root`, as `git ls-files` lists them. */
export function trackedSourceFiles(root: string): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "src", "web"], {
    cwd: root,
  });
  if (listed.exitCode !== 0)
    throw new Error(`git ls-files failed in ${root}: ${listed.stderr}`);
  return listed.stdout
    .toString()
    .split("\0")
    .filter((file) => /\.(ts|tsx|js|mjs)$/.test(file));
}
