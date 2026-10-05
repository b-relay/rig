import { test, expect } from "bun:test";
import { prepareInteractiveRequest } from "./interaction";
import type { CliDependencies } from "./types";
function fixture() {
  const requests: unknown[] = [];
  const prompts: string[] = [];
  const deps: CliDependencies = {
    root: "/isolated",
    cwd: "/repo",
    client: {
      async status(selection) {
        requests.push({ ...selection, action: "status" });
        return {
          project: "demo",
          targets: [
            {
              name: "working",
              kind: "working",
              state: "configured",
              components: [],
            },
            {
              name: "stable",
              kind: "stable",
              state: "stopped",
              components: [],
            },
            {
              name: "old-preview",
              kind: "preview",
              state: "stopped",
              components: [],
            },
          ],
        };
      },
      async command(request) {
        requests.push(request);
        if (request.action === "initialization-info")
          return {
            name: "demo",
            productionBranch: "trunk",
            currentBranch: "feature/wip",
            gitRequired: true,
            existing: false,
          };
        if (request.action === "deployment-context")
          return {
            project: "demo",
            repoPath: "/repo",
            productionBranch: "main",
            selected: request.target === "stable" ? "stable" : "preview",
            currentBranch: "feature",
          };
        return {
          targets: [
            { name: "working", kind: "working", state: "configured" },
            { name: "stable", kind: "stable", state: "stopped" },
            { name: "old-preview", kind: "preview", state: "stopped" },
          ],
        };
      },
    },
    output: { write() {}, error() {} },
    diagnostics: {
      async record() {
        return {};
      },
    },
    wait: async () => {},
    newOperationId: () => "op",
    interaction: {
      async text(message, defaultValue) {
        prompts.push(message);
        return defaultValue;
      },
      async confirm() {
        return true;
      },
    },
  };
  return { deps, requests, prompts };
}
test("a lifecycle request is never given a Target here: the grammar defaults it, and nothing is read", async () => {
  const { deps, requests } = fixture();
  for (const action of ["up", "down", "restart", "logs"] as const)
    expect(
      await prepareInteractiveRequest({ action, target: "working" }, deps),
    ).toEqual({ action, target: "working" });
  expect(requests).toHaveLength(0);
});
test("init presents identity and the default Production branch, naming a differing checkout, and Git creation requires affirmative choice", async () => {
  const { deps, prompts } = fixture();
  expect(
    await prepareInteractiveRequest(
      { action: "init", repoPath: "/repo" },
      deps,
    ),
  ).toMatchObject({
    project: "demo",
    productionBranch: "trunk",
    createGit: true,
  });
  expect(prompts).toEqual([
    "Project name",
    "Production branch (the checkout is on 'feature/wip')",
  ]);
  deps.interaction!.confirm = async () => false;
  await expect(
    prepareInteractiveRequest({ action: "init", repoPath: "/repo" }, deps),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});
test("implicit Production deployment requires explicit branch noninteractively on mismatch and confirmation in TTY", async () => {
  const { deps } = fixture();
  expect(
    await prepareInteractiveRequest(
      { action: "deploy", target: "stable" },
      deps,
    ),
  ).toMatchObject({ branch: "main" });
  delete deps.interaction;
  await expect(
    prepareInteractiveRequest({ action: "deploy", target: "stable" }, deps),
  ).rejects.toMatchObject({ code: "PRODUCTION_CONFIRMATION" });
  expect(
    await prepareInteractiveRequest(
      { action: "deploy", target: "stable", branch: "main" },
      deps,
    ),
  ).toMatchObject({ branch: "main" });
});

test("Production confirmation follows the role rigd says the selector means", async () => {
  const { deps } = fixture();
  const asked: unknown[] = [];
  deps.client.command = async (command) => {
    asked.push(command);
    return {
      project: "demo",
      repoPath: "/repo",
      productionBranch: "main",
      selected: "stable",
      currentBranch: "feature",
    };
  };
  delete deps.interaction;
  await expect(
    prepareInteractiveRequest({ action: "deploy", target: "stable" }, deps),
  ).rejects.toMatchObject({
    code: "PRODUCTION_CONFIRMATION",
    hint: "Pass the Production Branch explicitly: rig deploy stable main.",
  });
  expect(asked).toEqual([
    expect.objectContaining({ action: "deployment-context", target: "stable" }),
  ]);
});

test("a deployment context that does not say which Target was selected is a protocol failure, not an unconfirmed deploy", async () => {
  const { deps } = fixture();
  deps.client.command = async () => ({
    project: "demo",
    repoPath: "/repo",
    productionBranch: "main",
    targets: { working: "working", stable: "stable" },
    currentBranch: "feature",
  });
  await expect(
    prepareInteractiveRequest({ action: "deploy", target: "stable" }, deps),
  ).rejects.toMatchObject({ code: "DAEMON_PROTOCOL" });
});

test("interactive read protocol errors are safe structured daemon failures", async () => {
  const { deps } = fixture();
  deps.client.command = async () => ({ unexpected: "secret-value" });
  await expect(
    prepareInteractiveRequest({ action: "deploy", target: "stable" }, deps),
  ).rejects.toMatchObject({ code: "DAEMON_PROTOCOL" });
});

test("cancellation while a context query is pending prevents a deploy request from being prepared", async () => {
  const { deps } = fixture(),
    controller = new AbortController();
  deps.signal = controller.signal;
  deps.client.command = async () => {
    controller.abort();
    return {
      project: "demo",
      repoPath: "/repo",
      productionBranch: "main",
      selected: "stable",
      currentBranch: "main",
    };
  };
  await expect(
    prepareInteractiveRequest({ action: "deploy", target: "stable" }, deps),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});
test("every deploy names the resolved Project, directory, Target, and Branch before the daemon acts", async () => {
  const { deps, requests } = fixture();
  const lines: string[] = [];
  deps.output = { write() {}, error: (text) => void lines.push(text) };
  await prepareInteractiveRequest(
    {
      action: "deploy",
      target: "stable",
      branch: "main",
      repoPath: "/elsewhere",
    },
    deps,
  );
  expect(requests[0]).toMatchObject({
    action: "deployment-context",
    repoPath: "/elsewhere",
  });
  expect(lines).toEqual(["Deploying demo (/repo) to stable from main.\n"]);
  lines.length = 0;
  await prepareInteractiveRequest(
    { action: "deploy", target: "preview", repoPath: "/repo" },
    deps,
  );
  expect(lines).toEqual(["Deploying demo (/repo) to preview from feature.\n"]);
});
