import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectDocuments } from "../src/adapters/project-documents";
import type { CommandRunner } from "../src/providers/contracts";

test("initialization suggests a lowercase directory slug while preserving configured identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-slug-")),
    repo = join(root, "My App.v2");
  await mkdir(repo);
  const run: CommandRunner = async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "",
  });
  const documents = createProjectDocuments(root, run);
  try {
    expect(await documents.initializationInfo(repo)).toMatchObject({
      name: "my-app-v2",
      productionBranch: "main",
      gitRequired: true,
    });
    await writeFile(
      join(repo, "rig.yaml"),
      "name: Exact_NAME\ncomponents: {}\n",
    );
    expect(await documents.initializationInfo(repo)).toMatchObject({
      name: "Exact_NAME",
      existing: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
