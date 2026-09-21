import { expect, test } from "bun:test";
import { inspectInitialization } from "../src/adapters/project-documents";
import type { ProjectDiscovery } from "../src/git/project";
import type {
  ConfigDocument,
  HostConfig,
  ProjectConfig,
} from "../src/config/types";

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
const absent = { exitCode: 1, stdout: "", stderr: "" };
/** A repository at /repo on branch work with no origin/HEAD, answered without a filesystem. */
function repoDiscovery(): ProjectDiscovery {
  const responses = [ok("false"), ok("worktree /repo\n"), absent, ok("work")];
  return {
    canonicalize: async (path) => path,
    run: async () => responses.shift() ?? absent,
  };
}

test("initialization takes the existing Project config from its reads, so a conflicting name fails PROJECT_IDENTITY and an absent config yields the requested name without touching the filesystem", async () => {
  const other: ConfigDocument<ProjectConfig> = {
    path: "/repo/rig.yaml",
    revision: "r1",
    config: { name: "other" } as ProjectConfig,
  };
  let hostReads = 0;
  const reads = (document?: ConfigDocument<ProjectConfig>) => ({
    discovery: repoDiscovery(),
    discoverConfig: async (path: string) =>
      document ? { repoPath: path, document } : undefined,
    hostConfig: async () => {
      hostReads += 1;
      return { deploy: { production_branch: "main" } } as HostConfig;
    },
  });
  await expect(
    inspectInitialization(
      "/repo",
      { action: "init", project: "mine", createGit: true },
      reads(other),
    ),
  ).rejects.toMatchObject({ code: "PROJECT_IDENTITY" });
  expect(hostReads).toBe(0);
  expect(
    await inspectInitialization(
      "/repo",
      { action: "init", project: "mine", createGit: true },
      reads(),
    ),
  ).toMatchObject({
    repoPath: "/repo",
    name: "mine",
    existing: undefined,
    productionBranch: "main",
    currentBranch: "work",
  });
  expect(hostReads).toBe(1);
});
