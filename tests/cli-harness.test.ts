import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RigError } from "../src/domain/errors";
import { cliHarness } from "./support/cli-harness";

test("a run fails when the code under test caught a call no scenario scripted", async () => {
  const cli = cliHarness({
    // Stands in for CLI code that asks rigd something on the side and swallows the refusal.
    command: async () => {
      await cli.deps.client.status({ repoPath: "/workspace" }).catch(() => {});
      return { projects: [] };
    },
  });
  await expect(cli.run(["list"])).rejects.toThrow(
    "The CLI made calls no scenario scripted: Unexpected status read.",
  );
});

test("a caught unscripted call through the dependencies fails verify once, naming the request", async () => {
  const cli = cliHarness();
  await cli.deps.client
    .command({ action: "list", repoPath: "/workspace" })
    .catch(() => {});
  expect(() => cli.verify()).toThrow(
    "The CLI made calls no scenario scripted: Unexpected daemon request: list.",
  );
  expect(() => cli.verify()).not.toThrow();
});

test("a failure the scenario scripted is no unexpected call", async () => {
  const cli = cliHarness({
    command: () => {
      throw new RigError("INVALID_CONFIG", "Fix it.", "Like this.");
    },
  });
  expect(await cli.run(["list"])).toBe(1);
  expect(() => cli.verify()).not.toThrow();
});

test("a test whose caught unscripted call was never verified fails when it ends, in whichever file it is", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rig-cli-harness-"));
  const harness = JSON.stringify(
    join(import.meta.dir, "support", "cli-harness.ts"),
  );
  try {
    // The clean file loads the harness first, so the unchecked one only fails if every test is checked on its own.
    const files = {
      "a-clean.test.ts": `test("scripts its read", async () => {
  const cli = cliHarness({ status: () => ({ project: "demo", targets: [] }) });
  await cli.deps.client.status({ repoPath: "/workspace" });
});`,
      "b-unchecked.test.ts": `test("swallows a status read", async () => {
  const cli = cliHarness();
  await cli.deps.client.status({ repoPath: "/workspace" }).catch(() => {});
});
test("comes after it", () => {});`,
    };
    for (const [name, body] of Object.entries(files))
      await writeFile(
        join(directory, name),
        `import { test } from "bun:test";\nimport { cliHarness } from ${harness};\n${body}\n`,
      );
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        ...Object.keys(files).map((name) => join(directory, name)),
      ],
      {
        cwd: directory,
        env: { ...process.env, RIG_ROOT: join(directory, ".rig") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const report = stdout + stderr;
    expect(await child.exited).toBe(1);
    expect(report).toContain(
      "The CLI made calls no scenario scripted: Unexpected status read.",
    );
    expect(report).toContain("(fail) swallows a status read");
    expect(report).toContain(" 2 pass");
    expect(report).toContain(" 1 fail");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
