import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectDocuments } from "../src/adapters/project-documents";
import { runCommand } from "../src/providers/command-runner";
import { inheritedEnvironment } from "../src/daemon/environment";
import { selectProject } from "../src/runtime/projects";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { RuntimeCommand } from "../src/daemon/protocol";

/** With real discovery in one Git repository holding a registered Project and a registered Project nested in it, a
 * command that needs only recorded state selects the Project whose directory it runs in, whatever is wrong with either
 * rig.yaml, and never stops its parent in its place. */
test("down from a nested registered Project whose rig.yaml is gone selects it, whether its parent's rig.yaml is valid or not, and an unregistered nested config is never its parent's", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "rig-recorded-selection-")),
  );
  try {
    const repo = join(directory, "repo");
    const child = join(repo, "child");
    const tools = join(child, "tools");
    await mkdir(join(child, "src"), { recursive: true });
    await mkdir(tools);
    const git = await runCommand({
      command: ["git", "init", "-q", repo],
      cwd: directory,
    });
    expect(git.exitCode).toBe(0);
    const documents = createProjectDocuments(
      join(directory, ".rig"),
      runCommand,
      inheritedEnvironment(process.env),
      directory,
    );
    const projects = [repo, child].map((repoPath) => ({
      id: repoPath === repo ? "parent" : "child",
      name: repoPath === repo ? "parent" : "child",
      repoPath,
      configPath: join(repoPath, "rig.yaml"),
      createdAt: "2026-10-20T00:00:00Z",
    }));
    const deps = {
      documents,
      store: { read: async () => ({ projects }) },
    } as unknown as RuntimeDependencies;
    const select = (action: RuntimeCommand["action"], cwd: string) =>
      selectProject({ action, repoPath: cwd }, deps, false).then(
        ({ project }) => project.name,
        (error: { message: string }) => `refused: ${error.message}`,
      );
    const parentConfig =
      "name: parent\nservices:\n  api:\n    command: sleep 120\n";
    for (const [parent, label] of [
      [parentConfig, "valid"],
      [`${parentConfig}unknown: 123\n`, "invalid"],
    ] as const) {
      await writeFile(join(repo, "rig.yaml"), parent);
      for (const action of ["down", "status", "logs"] as const)
        expect({
          parent: label,
          action,
          selected: await select(action, join(child, "src")),
        }).toEqual({
          parent: label,
          action,
          selected: "child",
        });
      // From the parent's own directory, the parent is the one.
      expect(await select("down", repo)).toBe("parent");
    }
    // The child's own invalid rig.yaml is the child's.
    await writeFile(join(child, "rig.yaml"), "name: child\nunknown: 1\n");
    expect(await select("down", join(child, "src"))).toBe("child");
    // An unregistered Project's invalid config inside the child is not the child's to answer for.
    await writeFile(join(tools, "rig.yaml"), "name: tools\nunknown: 1\n");
    expect(await select("down", tools)).toBe(
      "refused: Invalid Project configuration.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
