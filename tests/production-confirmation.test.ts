import { expect, test } from "bun:test";
import { prepareInteractiveRequest } from "../src/cli/interaction";
import type { RuntimeCommand } from "../src/daemon/protocol";

test("without a terminal, a stable deploy off the Production Branch prints that Branch quoted, so the copied command deploys exactly it", async () => {
  const refusal = (productionBranch: string) =>
    prepareInteractiveRequest(
      {
        action: "deploy",
        repoPath: "/repo",
        target: "stable",
      } as RuntimeCommand,
      {
        signal: new AbortController().signal,
        interaction: undefined,
        output: { error() {} } as never,
        client: {
          command: async () => ({
            project: "demo",
            repoPath: "/repo",
            productionBranch,
            currentBranch: "work",
            selected: "stable",
          }),
        } as never,
      },
    );
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
