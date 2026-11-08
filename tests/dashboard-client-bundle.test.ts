import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** What the browser is sent of the dashboard: the modules its "use client" files reach. None of them may load the full Zod
 * API or a module that holds rigd's schemas: those belong on the server, and in the browser they cost every page's first
 * load. A Server Action file reaches the browser only as references to its actions, so the walk stops there. The built
 * chunks themselves are checked in tests/dashboard-render-e2e.test.ts. */

const repository = join(import.meta.dir, "..");
const web = join(repository, "web");
const SCHEMA_MODULES = [
  "src/daemon/protocol.ts",
  "src/domain/project-status.ts",
  "src/domain/dns-records.ts",
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".next") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const directive = (file: string, name: string) =>
  new RegExp(`^\\s*["']${name}["']`).test(readFileSync(file, "utf8"));
/** Each module the browser loads, with the module that first imported it, and the packages each one imports. Type-only
 * imports are not followed: they leave nothing in a bundle. */
function browserModules() {
  const ts = new Bun.Transpiler({ loader: "ts" });
  const tsx = new Bun.Transpiler({ loader: "tsx" });
  const from = new Map<string, string | undefined>();
  const packages = new Map<string, string[]>();
  const queue = sources(web).filter((file) => directive(file, "use client"));
  for (const file of queue) from.set(file, undefined);
  while (queue.length) {
    const file = queue.shift()!;
    const transpiler = file.endsWith(".tsx") ? tsx : ts;
    const imports = transpiler.scan(readFileSync(file, "utf8")).imports;
    const named: string[] = [];
    for (const { path } of imports) {
      if (!path.startsWith(".") && !path.startsWith("@/")) {
        named.push(path);
        continue;
      }
      const resolved = Bun.resolveSync(
        path.startsWith("@/") ? join(web, path.slice(2)) : path,
        dirname(file),
      );
      if (from.has(resolved) || directive(resolved, "use server")) continue;
      from.set(resolved, file);
      queue.push(resolved);
    }
    packages.set(file, named);
  }
  const chain = (file: string): string => {
    const parent = from.get(file);
    const name = relative(repository, file);
    return parent ? `${chain(parent)} -> ${name}` : name;
  };
  return { modules: [...from.keys()], packages, chain };
}

test("no module the browser loads imports the full Zod API or one of rigd's schema modules", () => {
  const { modules, packages, chain } = browserModules();
  // The walk reaches the shared pieces, so an empty result is not a walk that found nothing.
  expect(modules.map((file) => relative(repository, file))).toContain(
    "web/lib/present.ts",
  );
  expect(modules.map((file) => relative(repository, file))).toContain(
    "web/lib/dns.ts",
  );
  const zod = modules
    .filter((file) => packages.get(file)!.includes("zod"))
    .map(chain);
  const schemas = modules
    .filter((file) =>
      SCHEMA_MODULES.includes(relative(repository, file).replace(/\\/g, "/")),
    )
    .map(chain);
  expect(zod).toEqual([]);
  expect(schemas).toEqual([]);
});
