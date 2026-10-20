import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The pages Next itself renders for a path the proxy lets through without the key (a missing static file, the icon)
 * go through the root layout, which must show nothing of rigd to such a request. Builds the site from a copy of this
 * checkout, so the repository's own build is left alone, and serves it with `next start` against a temporary Rig root
 * whose rigd is a stand-in that counts every request it receives. */

const repository = join(import.meta.dir, "..");
const KEY = "render-test-access-key-".padEnd(43, "k");
let work: string;
let site: ReturnType<typeof Bun.spawn> | undefined;
let rigd: ReturnType<typeof Bun.serve> | undefined;
let reads = 0;
let base = "";

const run = async (argv: string[], cwd: string) => {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`${argv.join(" ")} exited ${code}\n${out}\n${err}`);
};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "rig-dashboard-render-"));
  const checkout = join(work, "checkout");
  const root = join(work, "root");
  for (const entry of ["web", "src", "package.json", "tsconfig.json"])
    await cp(join(repository, entry), join(checkout, entry), {
      recursive: true,
      filter: (source) =>
        !/[/\\]web[/\\](?:\.next|next-env\.d\.ts)/.test(source),
    });
  // A clone, not a link: Turbopack refuses a node_modules that points outside its root. APFS clones it in place.
  await run(
    [
      "cp",
      "-cR",
      join(repository, "node_modules"),
      join(checkout, "node_modules"),
    ],
    work,
  );
  await run(["bun", "--bun", "next", "build", "web"], checkout);

  rigd = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      reads += 1;
      return Response.json({ error: { code: "STAND_IN", message: "x" } });
    },
  });
  await mkdir(join(root, "daemon"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "daemon", "address.json"),
    JSON.stringify({ port: rigd.port, pid: process.pid, instanceId: "test" }),
  );
  await writeFile(join(root, "auth", "control-plane.token"), "token\n", {
    mode: 0o600,
  });
  await writeFile(join(root, "auth", "dashboard.key"), `${KEY}\n`, {
    mode: 0o600,
  });
  const free = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = free.port;
  free.stop(true);
  base = `http://127.0.0.1:${port}`;
  site = Bun.spawn(
    [
      "bun",
      "--bun",
      "next",
      "start",
      "web",
      "-H",
      "127.0.0.1",
      "-p",
      String(port),
    ],
    {
      cwd: checkout,
      env: {
        ...process.env,
        PORT: String(port),
        RIG_ROOT: root,
        RIG_WEB_KEY_FILE: join(root, "auth", "dashboard.key"),
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await fetch(`${base}/healthz`).then(
      (answer) => answer.ok,
      () => false,
    );
    if (ready) return;
    await Bun.sleep(250);
  }
  throw new Error("next start did not answer /healthz within a minute");
}, 600_000);

afterAll(async () => {
  site?.kill();
  await site?.exited;
  rigd?.stop(true);
  if (work) await rm(work, { recursive: true, force: true });
});

const render = async (path: string, headers: Record<string, string> = {}) => {
  const answer = await fetch(`${base}${path}`, { headers });
  return {
    status: answer.status,
    csp: answer.headers.get("content-security-policy"),
    body: await answer.text(),
  };
};

test("a missing static file and the icon render a bare not-found page without the key, and read nothing of rigd", async () => {
  reads = 0;
  for (const path of ["/_next/static/chunks/missing.js", "/favicon.ico"]) {
    const page = await render(path);
    expect(page.status).toBe(404);
    expect(page.csp).toContain("default-src 'none'");
    expect(page.body).not.toContain("<aside");
  }
  // Next answers a missing static file with a plain 404; the icon it renders through the root layout.
  expect((await render("/favicon.ico")).body).toContain("Not here");
  expect(reads).toBe(0);
  // The same page with the key carries the sidebar, which reads rigd: the check above is the layout's own.
  const signedIn = await render("/favicon.ico", {
    authorization: `Basic ${Buffer.from(`rig:${KEY}`).toString("base64")}`,
  });
  expect(signedIn.status).toBe(404);
  expect(signedIn.body).toContain("<aside");
  expect(reads).toBeGreaterThan(0);
}, 60_000);
