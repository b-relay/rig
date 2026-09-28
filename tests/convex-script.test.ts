import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECIPE_FILE_TEXT } from "../src/recipes/generated-files";
import { fakeConvexHome, FAKE_RELEASE } from "./support/fake-convex";

// The helper script as a Project has it: the text rig writes, run with bun the way the recipe's `run` runs it, against
// a fake backend in Convex's cache under a temporary HOME and a fake bunx. Ports are ephemeral, directories temporary.
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = server.port!;
  server.stop(true);
  return port;
}
async function project() {
  const fake = await fakeConvexHome();
  // Real path: the fake bunx reports its working directory as the kernel names it.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "rig-convex-script-")),
  );
  cleanups.push(() => rm(fake.home, { recursive: true, force: true }));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await writeFile(
    join(workspace, "scripts", "rig-convex.ts"),
    RECIPE_FILE_TEXT["rig-convex.ts"],
  );
  const [cloud, site] = [await freePort(), await freePort()];
  const start = (environment: Record<string, string> = {}) => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "scripts/rig-convex.ts"],
      {
        cwd: workspace,
        env: {
          PATH: `${fake.bin}:/usr/bin:/bin`,
          HOME: fake.home,
          TZ: "America/New_York",
          CONVEX_CLOUD_PORT: String(cloud),
          CONVEX_SITE_PORT: String(site),
          CONVEX_STATE_DIR: join(root, "data", "backend"),
          // Pinned and cached, so the script never asks the network.
          CONVEX_BACKEND_VERSION: FAKE_RELEASE,
          ...environment,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    cleanups.push(async () => {
      child.kill("SIGKILL");
      await child.exited;
    });
    return child;
  };
  return { fake, root, workspace, cloud, site, start };
}
async function answers(port: number): Promise<string | undefined> {
  return await fetch(`http://127.0.0.1:${port}/instance_name`, {
    signal: AbortSignal.timeout(500),
  }).then(
    (response) => response.text(),
    () => undefined,
  );
}
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not reached");
}

test("the script starts the backend on loopback without TZ, runs convex dev against it with Cloud keys blanked, and a SIGTERM ends both and exits 0", async () => {
  const p = await project();
  await writeFile(
    join(p.workspace, ".env.local"),
    "CONVEX_DEPLOYMENT=dev:cloud-app\nKEEP=1\n",
  );
  const child = p.start({ CONVEX_DEPLOY_KEY: "prod:app|secret" });
  await until(async () =>
    (await readFile(p.fake.bunxLog, "utf8").catch(() => "")).includes(
      "convex dev",
    ),
  );
  expect(await answers(p.cloud)).toBe("convex-self-hosted");
  const [run] = await p.fake.runs();
  expect(run!.args.slice(0, 2)).toEqual(["--interface", "127.0.0.1"]);
  expect(run!.tz).toBeNull();
  // convex dev: the self-hosted pair, and the Service's Cloud key set empty.
  expect(await readFile(p.fake.bunxLog, "utf8")).toBe(
    `convex dev|http://127.0.0.1:${p.cloud}||${p.workspace}\n`,
  );
  expect(await readFile(join(p.workspace, ".env.local"), "utf8")).toBe(
    `# CONVEX_DEPLOYMENT=dev:cloud-app  # set aside by rig-convex.ts\nKEEP=1\n\n# Convex backend run by scripts/rig-convex.ts\nCONVEX_SELF_HOSTED_URL=http://127.0.0.1:${p.cloud}\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|fake-admin-key\n`,
  );
  expect(
    JSON.parse(
      await readFile(join(p.root, "data", "backend", "config.json"), "utf8"),
    ),
  ).toMatchObject({
    deploymentName: "convex-self-hosted",
    backendVersion: FAKE_RELEASE,
  });

  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  expect(await answers(p.cloud)).toBeUndefined();
  expect((await readFile(p.fake.bunxLog, "utf8")).split("\n")).toContain(
    "stopped",
  );
  expect(await new Response(child.stdout).text()).toContain(
    `Convex backend convex-self-hosted (${FAKE_RELEASE}) is up at http://127.0.0.1:${p.cloud}`,
  );
});

test("when convex dev ends by itself the script stops the backend and exits with a failure; a bad setting fails at once with a hint", async () => {
  const p = await project();
  // A bunx that exits at once, as a broken Convex CLI would.
  await writeFile(join(p.fake.bin, "bunx"), "#!/bin/sh\nexit 3\n");
  const child = p.start();
  expect(await child.exited).toBe(3);
  expect(await new Response(child.stderr).text()).toContain(
    "convex dev exited with code 3; stopping the Convex Service.",
  );
  expect(await answers(p.cloud)).toBeUndefined();

  const bad = p.start({ CONVEX_STATE_DIR: "relative" });
  expect(await bad.exited).toBe(1);
  expect(await new Response(bad.stderr).text()).toBe(
    "rig-convex: CONVEX_STATE_DIR must be an absolute directory, such as ${rig.data}/backend. (CONVEX_SETTINGS)\nSet it in the Service's env in rig.yaml; the convex recipe sets CONVEX_CLOUD_PORT, CONVEX_SITE_PORT and CONVEX_STATE_DIR.\n",
  );
});

test("a port something already answers on is refused before the backend starts or .env.local is touched", async () => {
  const p = await project();
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: p.cloud,
    fetch: () => new Response("someone-else"),
  });
  cleanups.push(async () => other.stop(true));
  const child = p.start();
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain(
    "(CONVEX_PORT_TAKEN)",
  );
  expect(await p.fake.runs()).toEqual([]);
  await expect(readFile(join(p.workspace, ".env.local"))).rejects.toThrow();
});
