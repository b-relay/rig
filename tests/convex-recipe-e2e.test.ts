import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

const RELEASE = "precompiled-2026-09-21-0cf49cb";
interface TargetReport {
  name: string;
  state: string;
  components: { name: string; state: string; port?: number }[];
}

/** A stand-in for the Convex backend binary in Convex's cache under a temporary HOME: `keygen` prints a key, and a run
 * serves `/instance_name` on the interface and ports it is given and records its arguments. */
const FAKE_BACKEND = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === "keygen") {
  process.stdout.write(value("--instance-name") + "|fake-admin-key\\n");
  process.exit(0);
}
appendFileSync(join(import.meta.dir, "runs.jsonl"), JSON.stringify(args) + "\\n");
const hostname = value("--interface");
Bun.serve({ hostname, port: Number(value("--port")), fetch: () => new Response(value("--instance-name")) });
Bun.serve({ hostname, port: Number(value("--site-proxy-port")), fetch: () => new Response("site") });
process.on("SIGTERM", () => process.exit(0));
`;
/** A stand-in for bunx: records how convex dev was asked for, then runs until it is stopped. */
const fakeBunx = (log: string) => `#!/bin/sh
echo "$*|$CONVEX_SELF_HOSTED_URL|$PWD" >> "${log}"
trap 'echo stopped >> "${log}"; exit 0' TERM
while :; do sleep 0.05; done
`;

test("the convex@2 recipe runs through ${rig.rigd} under a real rigd: the backend passes the loopback check, its deployment lives in the Service's persistent data for the Working copy and a deployed Target, and a stop ends both processes", async () => {
  const home = await mkdtemp(join(tmpdir(), "rig-convex-home-"));
  const binaries = join(home, ".cache", "convex", "binaries", RELEASE);
  await mkdir(binaries, { recursive: true });
  await writeFile(join(binaries, "convex-local-backend"), FAKE_BACKEND);
  await chmod(join(binaries, "convex-local-backend"), 0o755);
  const bin = join(home, "bin");
  await mkdir(bin);
  const bunxLog = join(home, "bunx.log");
  await writeFile(join(bin, "bunx"), fakeBunx(bunxLog));
  await chmod(join(bin, "bunx"), 0o755);
  // src/rigd.ts runs through its #!/usr/bin/env bun line, so the Service's PATH has bun on it, as the recipe's bunx needs.
  const f = await rigFixture({
    HOME: home,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
  });
  const success = (result: {
    code: number;
    stdout: string;
    stderr: string;
  }) => {
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return result.stdout;
  };
  const convexPort = async (target: string) => {
    const report = (
      JSON.parse(
        success(await f.rig(["status", "--project", "demo", "--json"], f.base)),
      ).targets as TargetReport[]
    ).find((each) => each.name === target)!;
    expect(report.state).toBe("healthy");
    return report.components.find((each) => each.name === "convex")!.port!;
  };
  try {
    await f.git(["init", "-b", "main"]);
    const block = success(await f.rig(["recipe", "generate", "convex"]));
    // Pinned, so the test never asks version.convex.dev; everything else is the generated block as printed.
    const pinned = block.replace(
      '--state-dir "$CONVEX_STATE_DIR"',
      `--state-dir "$CONVEX_STATE_DIR" --backend-version ${RELEASE}`,
    );
    expect(pinned).not.toBe(block);
    await writeFile(join(f.repo, ".gitignore"), ".env.local\n");
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: demo\nservices:\n${pinned}`,
    );
    await f.commit();
    success(await f.rigd(["install"]));
    success(await f.rig(["init"]));

    expect(
      JSON.parse(success(await f.rig(["up", "local", "--json"]))),
    ).toMatchObject({ outcome: "started" });
    const localPort = await convexPort("local");
    expect(
      await (await fetch(`http://127.0.0.1:${localPort}/instance_name`)).text(),
    ).toBe("convex-self-hosted");
    const runs = (await readFile(join(binaries, "runs.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.slice(0, 4)).toEqual([
      "--interface",
      "127.0.0.1",
      "--port",
      String(localPort),
    ]);
    const localState = dirname(runs[0]!.at(-1)!);
    expect(localState.startsWith(f.root)).toBe(true);
    expect(localState.endsWith(join("convex", "backend"))).toBe(true);
    expect(
      JSON.parse(await readFile(join(localState, "config.json"), "utf8")),
    ).toMatchObject({
      deploymentName: "convex-self-hosted",
      backendVersion: RELEASE,
      adminKey: "convex-self-hosted|fake-admin-key",
    });
    expect(await readFile(join(f.repo, ".env.local"), "utf8")).toContain(
      `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${localPort}\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|fake-admin-key\n`,
    );
    await waitFor(async () =>
      (await readFile(bunxLog, "utf8").catch(() => "")).includes("convex dev"),
    );
    expect(await readFile(bunxLog, "utf8")).toBe(
      `convex dev|http://127.0.0.1:${localPort}|${f.canonicalRepo}\n`,
    );

    // A deployed Target runs in a fresh checkout with a deployment of its own in its own persistent data.
    expect(
      JSON.parse(success(await f.rig(["deploy", "live", "--json"]))),
    ).toMatchObject({ outcome: "deployed" });
    const livePort = await convexPort("live");
    const liveRun = (await readFile(join(binaries, "runs.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .at(-1)!;
    expect(liveRun[3]).toBe(String(livePort));
    const liveState = dirname(liveRun.at(-1)!);
    expect(liveState).not.toBe(localState);
    expect(liveState.startsWith(f.root)).toBe(true);

    for (const target of ["local", "live"])
      success(await f.rig(["down", target]));
    for (const port of [localPort, livePort])
      await expect(
        fetch(`http://127.0.0.1:${port}/instance_name`, {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow();
    expect(
      (await readFile(bunxLog, "utf8"))
        .split("\n")
        .filter((line) => line === "stopped"),
    ).toHaveLength(2);
    // The deployment outlives the stop.
    expect(await readFile(join(localState, "config.json"), "utf8")).toContain(
      RELEASE,
    );
  } finally {
    await f.cleanup();
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not reached");
}
