import { expect, test } from "bun:test";
import { prepareInteractiveRequest } from "../src/cli/interaction";
import { runRigCli } from "../src/cli/rig";
import { shellArgs } from "./support/shell-args";
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

test("the Production retry keeps every flag the deploy was given, so the copied command deploys the same way", async () => {
  const run = async (args: string[]) => {
    const requests: RuntimeCommand[] = [];
    let err = "";
    const code = await runRigCli(args, {
      root: "/isolated/.rig",
      cwd: "/workspace",
      client: {
        async status() {
          return { project: "shop", targets: [] };
        },
        async command(request: RuntimeCommand) {
          requests.push(request);
          return request.action === "deployment-context"
            ? {
                project: "shop",
                repoPath: "/repo",
                productionBranch: "main",
                currentBranch: "feature/login",
                selected: "stable",
              }
            : { outcome: "deployed" };
        },
      },
      output: {
        write() {},
        error(text: string) {
          err += text;
        },
      },
      diagnostics: { record: async () => ({}) },
      wait: async () => {},
      newOperationId: () => "op-1",
    });
    return { code, requests, err };
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
