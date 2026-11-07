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

/** The modules `file` imports, in order, among the repository's own files; `@/` is the dashboard's root. */
const imported = new Map<string, string[]>();
function imports(file: string): string[] {
  let found = imported.get(file);
  if (found) return found;
  const scanner = new Bun.Transpiler({
    loader: file.endsWith("x") ? "tsx" : "ts",
  });
  found = scanner
    .scanImports(readFileSync(file, "utf8"))
    .map(({ path }) =>
      path.startsWith("@/")
        ? join(REPOSITORY, "web", path.slice(2))
        : path.startsWith(".")
          ? join(dirname(file), path)
          : undefined,
    )
    .filter((path): path is string => path !== undefined)
    .map((path) => Bun.resolveSync(path, dirname(file)))
    .filter((path) => !path.includes("/node_modules/"));
  imported.set(file, found);
  return found;
}
/** Whether `file`, or anything it imports, reads the running site's settings or policy. */
function reachesSite(file: string): boolean {
  const seen = new Set([file]);
  for (const each of seen) {
    if (
      !each.endsWith("web/server/site.ts") &&
      /\bsite(Policy)?\(\)/.test(readFileSync(each, "utf8"))
    )
      return true;
    for (const next of imports(each)) seen.add(next);
  }
  return false;
}

test("every test that can reach the site's settings or access key imports the test site before anything that reads them", async () => {
  const fixture = join(REPOSITORY, "tests", "support", "dashboard-site.ts");
  const unowned: string[] = [];
  for (const name of await readdir(join(REPOSITORY, "tests"))) {
    if (!/\.test\.tsx?$/.test(name)) continue;
    const order = imports(join(REPOSITORY, "tests", name));
    const first = order.findIndex(reachesSite);
    const own = order.indexOf(fixture);
    if (first !== -1 && (own === -1 || own > first))
      unowned.push(`tests/${name}`);
  }
  expect(unowned).toEqual([]);
});
