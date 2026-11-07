import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseTrustedClients } from "../web/server/guard";

/** The dashboard's Server Actions read the site's settings from the process environment once, and its access key from the
 * file those settings name. A test that reaches them must own those settings (tests/support/dashboard-site.ts), so that
 * what the test process inherited, an operator's own key file included, is never read, changed or created. */

const REPOSITORY = join(import.meta.dir, "..");
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

/** Every variable the site's settings are read from, as web/server/site.ts names them. */
async function siteVariables(): Promise<string[]> {
  const source = await readFile(join(REPOSITORY, "web/server/site.ts"), "utf8");
  return [
    ...new Set([...source.matchAll(/\benv\.([A-Z_]+)/g)].map((m) => m[1]!)),
  ];
}

/** An operator's own dashboard settings, inherited: a key file of theirs (readable by others, as one placed by hand may
 * be), a key path where there is none, a sandbox root, other hosts and clients. */
async function inherited() {
  const home = await mkdtemp(join(tmpdir(), "rig-dashboard-inherited-"));
  homes.push(home);
  const key = join(home, "operator.key");
  await writeFile(key, `${"operator-key-".padEnd(43, "o")}\n`);
  await chmod(key, 0o644);
  const values: Record<string, string> = {
    PORT: "4999",
    RIG_ROOT: join(home, "rig"),
    RIG_WEB_KEY_FILE: key,
    RIG_WEB_HOST: "elsewhere.example",
    RIG_WEB_DASHBOARD_HOST: "dashboard.elsewhere.example",
    RIG_WEB_TRUSTED_CLIENTS: "203.0.113.0/24",
    RIG_WEB_SANDBOX_ROOT: join(home, "sandbox"),
    RIG_WEB_REPOSITORY: join(home, "repository"),
  };
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  for (const name of await siteVariables())
    env[name] = values[name] ?? `inherited-${name}`;
  const untouched = async () => {
    expect(await readdir(home)).toEqual(["operator.key"]);
    expect(await readFile(key, "utf8")).toBe(
      `${"operator-key-".padEnd(43, "o")}\n`,
    );
    expect((await stat(key)).mode & 0o777).toBe(0o644);
  };
  return { env, untouched };
}

async function run(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: REPOSITORY,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("the test site's settings are its own, whatever dashboard settings the test process inherited, and its key is its own", async () => {
  const { env, untouched } = await inherited();
  const probe = await run(
    [
      "-e",
      `const { SITE } = await import("./tests/support/dashboard-site.ts");
       const { site, sitePolicy } = await import("./web/server/site.ts");
       const policy = await sitePolicy();
       console.log(JSON.stringify({ SITE, site: site(), key: policy.accessKey }));`,
    ],
    env,
  );
  expect(probe.stderr).toBe("");
  const { SITE, site, key } = JSON.parse(probe.stdout);
  expect(site).toEqual({
    port: SITE.port,
    root: SITE.root,
    keyFile: SITE.keyFile,
    publicHost: SITE.host,
    trustedClients: JSON.parse(
      JSON.stringify(parseTrustedClients(SITE.trusted)),
    ),
    repository: REPOSITORY,
  });
  expect(key).toBe(SITE.key);
  await untouched();
});

test("the Restore action tests pass with an operator's dashboard settings inherited, and leave their files alone", async () => {
  const { env, untouched } = await inherited();
  const tests = await run(
    ["test", "./tests/dashboard-restore-action.test.ts"],
    env,
  );
  expect({ code: tests.code, output: tests.stderr }).toMatchObject({
    code: 0,
    output: expect.stringContaining(" 0 fail"),
  });
  await untouched();
});

const SITE_MODULE = join(REPOSITORY, "web", "server", "site.ts");
const FIXTURE = join(REPOSITORY, "tests", "support", "dashboard-site.ts");
/** Sources by path; a test of the check itself supplies files that are not on disk. */
const sources = new Map<string, string>();
const sourceOf = (file: string) => {
  const source = sources.get(file) ?? readFileSync(file, "utf8");
  sources.set(file, source);
  return source;
};
/** Where `specifier`, imported from `file`, resolves among the repository's own files; `@/` is the dashboard's root. */
function resolved(file: string, specifier: string): string | undefined {
  const path = specifier.startsWith("@/")
    ? join(REPOSITORY, "web", specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(file), specifier)
      : undefined;
  if (path === undefined) return undefined;
  const found = Bun.resolveSync(path, dirname(file));
  return found.includes("/node_modules/") ? undefined : found;
}
/** The modules `file` imports, in order. */
const imported = new Map<string, string[]>();
function imports(file: string): string[] {
  let found = imported.get(file);
  if (found) return found;
  const scanner = new Bun.Transpiler({
    loader: file.endsWith("x") ? "tsx" : "ts",
  });
  found = scanner
    .scanImports(sourceOf(file))
    .map(({ path }) => resolved(file, path))
    .filter((path): path is string => path !== undefined);
  imported.set(file, found);
  return found;
}
/** Whether `file` takes the running site's settings or policy (`site` or `sitePolicy`) from web/server/site.ts, under
 * whatever name: by name, as the whole module, or by importing it at run time. Its pure `siteSettings` reads nothing. */
function acquires(file: string): boolean {
  const source = sourceOf(file);
  for (const [, typeOnly, clause, specifier] of source.matchAll(
    /import\s+(type\s+)?([^'";]*?)\s*from\s*["']([^"']+)["']/g,
  )) {
    if (typeOnly || resolved(file, specifier!) !== SITE_MODULE) continue;
    const named = /\{([^}]*)\}/.exec(clause!);
    const names = (named?.[1] ?? "").split(",").map(
      (each) =>
        each
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0],
    );
    // A default or namespace import is the whole module.
    const whole = clause!
      .replace(/\{[^}]*\}/, "")
      .replace(/,/g, "")
      .trim();
    if (names.includes("site") || names.includes("sitePolicy") || whole)
      return true;
  }
  return [...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].some(
    ([, specifier]) => resolved(file, specifier!) === SITE_MODULE,
  );
}
/** Whether `file`, or anything it imports, takes the running site's settings or policy. */
function reachesSite(file: string): boolean {
  const seen = new Set([file]);
  for (const each of seen) {
    if (acquires(each)) return true;
    for (const next of imports(each)) seen.add(next);
  }
  return false;
}
/** Whether the test `file` imports the test site before anything, itself included, that takes the site's settings. */
function ownsSite(file: string): boolean {
  const order = imports(file);
  const first = order.findIndex(
    (path) => reachesSite(path) || (path === SITE_MODULE && acquires(file)),
  );
  const own = order.indexOf(FIXTURE);
  return first === -1 || (own !== -1 && own <= first);
}

test("every test that can reach the site's settings or access key imports the test site before anything that reads them", async () => {
  const unowned: string[] = [];
  for (const name of await readdir(join(REPOSITORY, "tests")))
    if (
      /\.test\.tsx?$/.test(name) &&
      !ownsSite(join(REPOSITORY, "tests", name))
    )
      unowned.push(`tests/${name}`);
  expect(unowned).toEqual([]);
});

test("the check refuses a test that takes the site's settings itself, under any name, unless the test site comes first", () => {
  const judged = (name: string, source: string) => {
    const file = join(REPOSITORY, "tests", `${name}.test.ts`);
    sources.set(file, `import { test } from "bun:test";\n${source}`);
    return ownsSite(file);
  };
  const body = `test("reads site policy", async () => { await sitePolicy(); });`;
  expect({
    named: judged(
      "unsafe-named",
      `import { sitePolicy } from "../web/server/site";\n${body}`,
    ),
    renamed: judged(
      "unsafe-renamed",
      `import { sitePolicy as policy } from "../web/server/site";\ntest("x", () => policy());`,
    ),
    whole: judged(
      "unsafe-whole",
      `import * as running from "../web/server/site";\ntest("x", () => running.site());`,
    ),
    later: judged(
      "unsafe-later",
      `test("x", async () => (await import("../web/server/site")).site());`,
    ),
    owned: judged(
      "safe-owned",
      `import "./support/dashboard-site";\nimport { sitePolicy } from "../web/server/site";\n${body}`,
    ),
    pure: judged(
      "safe-pure",
      `import { siteSettings } from "../web/server/site";\ntest("x", () => siteSettings({}, "/", "/"));`,
    ),
  }).toEqual({
    named: false,
    renamed: false,
    whole: false,
    later: false,
    owned: true,
    pure: true,
  });
});
