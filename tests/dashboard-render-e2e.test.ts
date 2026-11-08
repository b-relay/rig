import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartTime } from "../src/daemon/process-identity";

/** The pages Next itself renders for a path the proxy lets through without the key (a missing static file, the icon)
 * go through the root layout, which must show nothing of rigd to such a request. A signed-in page sends its sidebar
 * once, and the build's browser scripts carry none of rigd's schemas. Builds the site from a copy of this
 * checkout, so the repository's own build is left alone, and serves it with `next start` against a temporary Rig root
 * whose rigd is a stand-in that counts every request it receives. */

const repository = join(import.meta.dir, "..");
const KEY = "render-test-access-key-".padEnd(43, "k");
let work: string;
let checkout: string;
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

/** Serves the built site against `root`, whose rigd record names the stand-in on `rigdPort`, and answers once it is up. */
async function serveSite(
  root: string,
  rigdPort: number,
): Promise<{ base: string; process: ReturnType<typeof Bun.spawn> }> {
  await mkdir(join(root, "daemon"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "daemon", "address.json"),
    // The record names this test process, with its start time, so discovery verifies it and dials the stand-in.
    JSON.stringify({
      port: rigdPort,
      pid: process.pid,
      instanceId: "test",
      startedAt: await processStartTime(process.pid),
    }),
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
  const served = Bun.spawn(
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
    const ready = await fetch(`http://127.0.0.1:${port}/healthz`).then(
      (answer) => answer.ok,
      () => false,
    );
    if (ready) return { base: `http://127.0.0.1:${port}`, process: served };
    await Bun.sleep(250);
  }
  served.kill();
  throw new Error("next start did not answer /healthz within a minute");
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "rig-dashboard-render-"));
  checkout = join(work, "checkout");
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
  ({ base, process: site } = await serveSite(root, rigd.port!));
}, 600_000);

// Removing the work directory removes a clone of node_modules and a Next build, tens of thousands of files: seconds of
// work on an idle Mac, more on a busy runner, so the hook's bound is sized for that work rather than the default 5 s.
afterAll(async () => {
  site?.kill();
  await site?.exited;
  rigd?.stop(true);
  if (work) await rm(work, { recursive: true, force: true });
}, 120_000);

const render = async (path: string, headers: Record<string, string> = {}) => {
  const answer = await fetch(`${base}${path}`, { headers });
  return {
    status: answer.status,
    csp: answer.headers.get("content-security-policy"),
    body: await answer.text(),
  };
};

test("a missing static file and the icon render a bare not-found page without the key, and read nothing of rigd; with it, the sidebar comes once", async () => {
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
  // A signed-in page sends its sidebar once, for both the open sidebar and the narrow screen's drawer. Here, not in a
  // test of its own, because this file's tests run at once and the count of reads above is this test's.
  const payload = await render("/activity?_rsc", {
    authorization: `Basic ${Buffer.from(`rig:${KEY}`).toString("base64")}`,
    rsc: "1",
  });
  expect(payload.status).toBe(200);
  expect(payload.body.split('"aria-label":"Projects"').length - 1).toBe(1);
  expect(payload.body.split('"aria-label":"Sections"').length - 1).toBe(1);
  expect(signedIn.body).toContain('aria-label="Open the menu"');
}, 60_000);

test("the browser's scripts hold none of rigd's schemas and no Zod error messages", async () => {
  const chunks = join(checkout, "web", ".next", "static", "chunks");
  const scripts = (await readdir(chunks)).filter((name) =>
    name.endsWith(".js"),
  );
  expect(scripts.length).toBeGreaterThan(0);
  for (const name of scripts) {
    const script = await Bun.file(join(chunks, name)).text();
    // rigd's schemas document every field; Zod's full API, or its compact one imported whole, brings its locales.
    expect(script, name).not.toContain(".describe(");
    expect(script, name).not.toContain("Too big: expected");
  }
});

/** One Project, its working Target running, and its last action: enough for each page to reach every read it makes. */
const PANTRY = {
  project: "pantry",
  projectId: "p-1",
  targets: [
    {
      id: "t-1",
      name: "working",
      kind: "working",
      state: "healthy",
      components: [
        {
          name: "web",
          kind: "managed",
          port: 4100,
          ports: { http: 4100 },
          pid: 4242,
          state: "healthy",
        },
      ],
    },
  ],
  warnings: [],
};
const OPERATIONS = {
  operations: [
    {
      id: "op-1",
      projectId: "p-1",
      project: "pantry",
      target: "working",
      action: "up",
      outcome: "started",
      occurredAt: "2026-11-08T10:00:00.000Z",
    },
  ],
  total: 1,
};

test("one render of each page asks rigd each thing at most once: the pages take rigd's health, queue and Activity from the page's pulse, and Monitor says what the queue says of new work", async () => {
  // Its own site and stand-in, since this file's tests run at once and every read here is counted.
  let asked: string[] = [];
  let queue: object = { waiting: 0, operations: [] };
  const counting = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/health") {
        asked.push("health");
        return Response.json({
          instanceId: "test",
          pid: process.pid,
          running: true,
          version: "test",
        });
      }
      const command = (await request.json()) as { action: string };
      asked.push(JSON.stringify(command));
      const result =
        command.action === "list"
          ? {
              projects: [
                { id: "p-1", name: "pantry", repoPath: work, targetCount: 1 },
              ],
            }
          : command.action === "status"
            ? PANTRY
            : command.action === "queue"
              ? queue
              : command.action === "activity"
                ? OPERATIONS
                : undefined;
      return Response.json(
        result ? { result } : { error: { code: "STAND_IN", message: "x" } },
      );
    },
  });
  const counted = await serveSite(join(work, "counted"), counting.port!);
  const pulse = ["health", '{"action":"queue"}', '{"action":"activity"}'];
  const work100 = '{"action":"activity","project":"pantry","lines":100}';
  const render = async (path: string) => {
    const page = await fetch(`${counted.base}${path}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`rig:${KEY}`).toString("base64")}`,
      },
    });
    return { status: page.status, body: await page.text() };
  };
  try {
    for (const [path, pageReads] of [
      ["/", [work100]],
      ["/projects/pantry", [work100]],
      ["/projects/pantry/targets/working", [work100]],
      ["/monitor", ['{"action":"doctor"}']],
      ["/activity", []],
      [
        "/activity?operation=op-1",
        ['{"action":"activity","operation":"op-1"}'],
      ],
    ] as const) {
      asked = [];
      const { status, body } = await render(path);
      expect(status, path).toBe(200);
      expect(body, path).not.toContain("This page did not render");
      expect(body, path).toContain("pantry");
      // The whole page has streamed, so every read it made has reached the stand-in.
      expect(
        asked.filter((each, at) => asked.indexOf(each) !== at),
        path,
      ).toEqual([]);
      expect(asked, path).toEqual(
        expect.arrayContaining([...pulse, ...pageReads]),
      );
    }
    // Monitor's rigd card and Uninstall readiness follow the queue read's `draining`, which the pulse reading carries.
    for (const [draining, shown, hidden] of [
      [
        undefined,
        [">Prepare uninstall<"],
        ["Cancel uninstall", "Prepared for uninstall", "New work"],
      ],
      [
        "uninstall-prepared",
        [
          "Prepared for uninstall",
          "Cancel uninstall",
          "refused: prepared for uninstall",
        ],
        [">Prepare uninstall<", "rigd is stopping"],
      ],
      [
        "stopping",
        ["rigd is stopping", "refused: rigd is stopping"],
        [">Prepare uninstall<", "Cancel uninstall", "Prepared for uninstall"],
      ],
    ] as const) {
      queue = { waiting: 0, operations: [], ...(draining && { draining }) };
      const { status, body } = await render("/monitor");
      expect(status, draining).toBe(200);
      for (const text of shown) expect(body, draining).toContain(text);
      for (const text of hidden) expect(body, draining).not.toContain(text);
    }
  } finally {
    counted.process.kill();
    await counted.process.exited;
    counting.stop(true);
  }
}, 120_000);

test("a redraw asked for by a poll that saw a CLI restart shows it, though a render's pulse read from before the restart is still out", async () => {
  // Its own site and stand-in, as above. The stand-in answers what it holds when a read arrives, and can hold one Activity
  // read: the render's, begun before the restart.
  const records: object[] = [];
  let holdNext = false;
  let reached = () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const stand = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/health")
        return Response.json({
          instanceId: "test",
          pid: process.pid,
          running: true,
          version: "test",
        });
      const command = (await request.json()) as { action: string };
      if (command.action === "activity") {
        const result = { operations: [...records], total: records.length };
        if (holdNext) {
          holdNext = false;
          reached();
          await held;
        }
        return Response.json({ result });
      }
      const result =
        command.action === "list"
          ? { projects: [] }
          : command.action === "queue"
            ? { waiting: 0, operations: [] }
            : undefined;
      return Response.json(
        result ? { result } : { error: { code: "STAND_IN", message: "x" } },
      );
    },
  });
  const served = await serveSite(join(work, "outside-change"), stand.port!);
  const headers = {
    authorization: `Basic ${Buffer.from(`rig:${KEY}`).toString("base64")}`,
  };
  const render = (path: string) =>
    fetch(`${served.base}${path}`, { headers }).then((page) => page.text());
  const poll = () =>
    fetch(`${served.base}/pulse`, { headers })
      .then((answer) => answer.json())
      .then((pulse) => (pulse as { stamp: string }).stamp);
  const restarted = {
    id: "op-cli",
    project: "pantry",
    target: "working",
    action: "restart",
    outcome: "restarted",
    message: "Restarted from the command line",
    occurredAt: "2026-11-08T10:00:00.000Z",
  };
  try {
    // Warm: both entries' code is loaded, and the browser has seen the stamp from before.
    await render("/activity");
    const seen = await poll();
    holdNext = true;
    const reachedHeld = new Promise<void>((resolve) => (reached = resolve));
    const first = render("/activity");
    await reachedHeld;
    records.push(restarted);
    // The live refresh: poll, and redraw once the stamp moves. A poll that joins the held read answers only once it does.
    let redraw: Promise<string> | undefined;
    for (let tick = 0; tick < 3 && !redraw; tick++) {
      const answer = poll();
      const settled = await Promise.race([
        answer,
        Bun.sleep(1500).then(() => undefined),
      ]);
      if (settled === undefined) release();
      if ((settled ?? (await answer)) !== seen) {
        redraw = render("/activity");
        // Long enough for the redraw to reach its pulse read before the held one answers.
        await Bun.sleep(1000);
      }
    }
    release();
    await first;
    expect(redraw).toBeDefined();
    const shown = await redraw!;
    expect(shown).toContain(restarted.message);
    expect(shown).not.toContain("Nothing has happened yet.");
  } finally {
    release();
    served.process.kill();
    await served.process.exited;
    stand.stop(true);
  }
}, 120_000);
