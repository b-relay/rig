import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fakeConvexHome, FAKE_RELEASE } from "./support/fake-convex";
import { rigFixture } from "./support/rig-fixture";

interface TargetReport {
  name: string;
  state: string;
  components: { name: string; state: string; port?: number }[];
}

test("the convex@2 recipe under a real rigd: generate writes the Project's helper script, its backend passes the loopback check, its deployment lives in each Target's persistent data, the deployed checkout carries the script, and a stop ends both processes", async () => {
  const fake = await fakeConvexHome();
  // The fake bunx comes first on the Service's PATH, then bun, which the recipe's run needs.
  const f = await rigFixture({
    HOME: fake.home,
    PATH: `${fake.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
  });
  const success = (result: {
    code: number;
    stdout: string;
    stderr: string;
  }) => {
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
    await writeFile(join(f.repo, "rig.yaml"), "name: demo\n");
    const generated = await f.rig(["recipe", "generate", "convex"]);
    expect(generated.code).toBe(0);
    expect(generated.stderr).toContain("Wrote scripts/rig-convex.ts in");
    // Pinned, so the test never asks version.convex.dev; everything else is the generated block as printed.
    const pinned = generated.stdout.replace(
      "      CONVEX_STATE_DIR: ${rig.data}/backend\n",
      `      CONVEX_STATE_DIR: \${rig.data}/backend\n      CONVEX_BACKEND_VERSION: ${FAKE_RELEASE}\n`,
    );
    expect(pinned).not.toBe(generated.stdout);
    await writeFile(join(f.repo, ".gitignore"), ".env.local\n");
    await writeFile(
      join(f.repo, "rig.yaml"),
      `name: demo\nservices:\n${pinned}`,
    );
    // The script is the Project's: it is committed, and so it is in the deployed checkout too.
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
    const runs = await fake.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args.slice(0, 4)).toEqual([
      "--interface",
      "127.0.0.1",
      "--port",
      String(localPort),
    ]);
    const localState = dirname(runs[0]!.args.at(-1)!);
    expect(localState.startsWith(f.root)).toBe(true);
    expect(localState.endsWith(join("convex", "backend"))).toBe(true);
    expect(
      JSON.parse(await readFile(join(localState, "config.json"), "utf8")),
    ).toMatchObject({
      deploymentName: "convex-self-hosted",
      backendVersion: FAKE_RELEASE,
      adminKey: "convex-self-hosted|fake-admin-key",
    });
    expect(await readFile(join(f.repo, ".env.local"), "utf8")).toContain(
      `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${localPort}\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|fake-admin-key\n`,
    );
    await waitFor(async () =>
      (await readFile(fake.bunxLog, "utf8").catch(() => "")).includes(
        "convex dev",
      ),
    );
    expect(await readFile(fake.bunxLog, "utf8")).toBe(
      `convex dev|http://127.0.0.1:${localPort}||${f.canonicalRepo}\n`,
    );

    // A deployed Target runs the script from its fresh checkout, with a deployment of its own in its own data.
    expect(
      JSON.parse(success(await f.rig(["deploy", "live", "--json"]))),
    ).toMatchObject({ outcome: "deployed" });
    const livePort = await convexPort("live");
    const liveRun = (await fake.runs()).at(-1)!;
    expect(liveRun.args[3]).toBe(String(livePort));
    const liveState = dirname(liveRun.args.at(-1)!);
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
      (await readFile(fake.bunxLog, "utf8"))
        .split("\n")
        .filter((line) => line === "stopped"),
    ).toHaveLength(2);
    // The deployment outlives the stop.
    expect(await readFile(join(localState, "config.json"), "utf8")).toContain(
      FAKE_RELEASE,
    );
  } finally {
    await f.cleanup();
    await rm(fake.home, { recursive: true, force: true });
  }
}, 120_000);

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not reached");
}
