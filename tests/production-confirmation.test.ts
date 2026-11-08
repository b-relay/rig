import { expect, test } from "bun:test";
import { prepareInteractiveRequest } from "../src/cli/interaction";
import { cliHarness } from "./support/cli-harness";
import { shellArgs } from "./support/shell-args";
import type { RuntimeCommand } from "../src/daemon/protocol";

test("without a terminal, a stable deploy off the Production Branch prints that Branch quoted, so the copied command deploys exactly it", async () => {
  const refusal = (productionBranch: string) => {
    const cli = cliHarness({
      command: () => ({
        project: "demo",
        repoPath: "/repo",
        productionBranch,
        currentBranch: "work",
        selected: "stable",
      }),
    });
    return prepareInteractiveRequest(
      {
        action: "deploy",
        repoPath: "/repo",
        target: "stable",
      } as RuntimeCommand,
      {
        ...cli.deps,
        signal: new AbortController().signal,
        interaction: undefined,
      },
    );
  };
  for (const [branch, printed] of [
    ["main", "rig deploy stable main."],
    ["feat/(draft)", "rig deploy stable 'feat/(draft)'."],
    ["fix/$HOME", "rig deploy stable 'fix/$HOME'."],
  ])
    await expect(refusal(branch)).rejects.toMatchObject({
      code: "PRODUCTION_CONFIRMATION",
      hint: `Pass the Production Branch explicitly: ${printed}`,
    });
});

test("the Production retry keeps every flag the deploy was given, so the copied command deploys the same way", async () => {
  const run = async (args: string[]) => {
    const cli = cliHarness({
      status: () => ({ project: "shop", targets: [] }),
      command: (request) =>
        request.action === "deployment-context"
          ? {
              project: "shop",
              repoPath: "/repo",
              productionBranch: "main",
              currentBranch: "feature/login",
              selected: "stable",
            }
          : { outcome: "deployed" },
    });
    const code = await cli.run(args);
    return { code, requests: cli.requests, err: cli.err() };
  };
  const refused = await run([
    "deploy",
    "stable",
    "--project",
    "shop",
    "--no-up",
    "--force",
  ]);
  expect(refused.code).toBe(1);
  const retry = "rig deploy stable main --project shop --force --no-up";
  expect(refused.err).toContain(
    `Pass the Production Branch explicitly: ${retry}.`,
  );
  const retried = await run(shellArgs(retry));
  expect(retried.code).toBe(0);
  expect(retried.requests.at(-1)).toMatchObject({
    action: "deploy",
    project: "shop",
    target: "stable",
    branch: "main",
    force: true,
    noUp: true,
  });
});
