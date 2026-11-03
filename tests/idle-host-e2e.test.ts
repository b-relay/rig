import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { rigFixture } from "./support/rig-fixture";

const SERVER = `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("ok") });\n`;
const bun = process.execPath;

/** What the preloaded `idle-tally` has counted so far. */
const tallied = async (path: string) =>
  JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as {
    reads?: number;
    spawns?: string[];
  };

/** Waits, by what rigd itself has done rather than by the clock, until it has read its state `reads` more times. */
async function afterReads(path: string, reads: number) {
  const until = ((await tallied(path)).reads ?? 0) + reads;
  for (let i = 0; i < 6000; i++) {
    const seen = await tallied(path);
    if ((seen.reads ?? 0) >= until) return seen;
    await Bun.sleep(10);
  }
  throw new Error("rigd never read its state");
}

/** Each observation file a capture wrapper keeps, and when it was last written. */
async function observations(root: string) {
  const directory = join(root, "capture");
  const names = (await readdir(directory)).filter((name) =>
    name.endsWith(".observation.json"),
  );
  return await Promise.all(
    names.map(async (name) => [
      name,
      (await stat(join(directory, name), { bigint: true })).mtimeNs,
    ]),
  );
}

describe.skipIf(process.platform !== "darwin")("an idle Host", () => {
  test("a rigd that adopted running Services starts no process, however many passes it makes, and their wrappers write nothing", async () => {
    const f = await rigFixture();
    try {
      await writeFile(join(f.repo, "server.ts"), SERVER);
      await writeFile(
        join(f.repo, "rig.yaml"),
        `name: idle
targets: { working: true }
services:
  web:
    command: exec '${bun}' server.ts
    ports: { http: auto }
    environment: { PORT: "\${port}" }
    healthcheck:
      test: http://127.0.0.1:\${port}/
      interval: 5s
  worker:
    command: exec /bin/sleep 600
`,
      );
      await f.git(["init", "-b", "main"]);
      expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
      expect(await f.rig(["init"])).toMatchObject({ code: 0 });
      expect(await f.rig(["up"])).toMatchObject({ code: 0 });
      // rigd stops and the Services run on, to be adopted by the one below, which counts what it starts.
      const { pid } = JSON.parse(
        await readFile(join(f.root, "daemon", "address.json"), "utf8"),
      ) as { pid: number };
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 1000; i++) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(10);
        } catch {
          break;
        }
      }
      const tally = join(f.base, "tally.json");
      const daemon = Bun.spawn(
        [
          bun,
          "--preload",
          resolve(import.meta.dir, "support/idle-tally.ts"),
          resolve(import.meta.dir, "../src/rigd.ts"),
        ],
        {
          cwd: f.root,
          env: {
            ...process.env,
            RIG_ROOT: f.root,
            RIG_DAEMON_CHILD: "1",
            IDLE_TALLY: tally,
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      try {
        // Its start reads the Host's session and is done once the first passes have read the state.
        const settled = await afterReads(tally, 12);
        const wrote = await observations(f.root);
        expect(wrote).toHaveLength(2);
        // Each pass reads the state at least three times: rigd's own, the health monitor's and the job scheduler's.
        const later = await afterReads(tally, 18);
        expect(later.spawns!.slice(settled.spawns!.length)).toEqual([]);
        expect(await observations(f.root)).toEqual(wrote);
        // Adopted, and still reported as it was.
        const status = JSON.parse((await f.rig(["status", "--json"])).stdout);
        expect(
          status.targets[0].components.map(
            (component: { state: string }) => component.state,
          ),
        ).toEqual(["healthy", "running"]);
      } finally {
        // While this rigd can still stop them: the fixture's own cleanup finds none to ask.
        await f.rig(["down"]);
        daemon.kill("SIGTERM");
        await daemon.exited;
      }
    } finally {
      await f.cleanup();
    }
  }, 120_000);
});
