import { test, expect } from "bun:test";
import { prepareInteractiveRequest } from "./interaction";
import type { CliDependencies } from "./types";
function fixture() {
  const requests: unknown[] = [];
  const choices: unknown[] = [];
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
              name: "local",
              kind: "local",
              state: "configured",
              components: [],
            },
            { name: "live", kind: "live", state: "stopped", components: [] },
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
            gitRequired: true,
            existing: false,
          };
        if (request.action === "deployment-context")
          return { productionBranch: "main", currentBranch: "feature" };
        return {
          targets: [
            { name: "local", kind: "local", state: "configured" },
            { name: "live", kind: "live", state: "stopped" },
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
      async select(_message, options) {
        choices.push(options);
        return "old-preview";
      },
      async text(_message, defaultValue) {
        return defaultValue;
      },
      async confirm() {
        return true;
      },
    },
  };
  return { deps, requests, choices };
}
test("missing Target prompts among observed configured and stopped Targets, never creates a Preview", async () => {
  const { deps, choices } = fixture();
  expect(
    await prepareInteractiveRequest({ action: "up", repoPath: "/repo" }, deps),
  ).toMatchObject({ target: "preview", deployment: "old-preview" });
  expect(choices[0]).toHaveLength(3);
});
test("noninteractive lifecycle requires an explicit Target without reading state", async () => {
  const { deps, requests } = fixture();
  delete deps.interaction;
  await expect(
    prepareInteractiveRequest({ action: "down" }, deps),
  ).rejects.toMatchObject({ code: "TARGET_REQUIRED" });
  expect(requests).toHaveLength(0);
});
test("init presents identity and detected Production branch, and Git creation requires affirmative choice", async () => {
  const { deps } = fixture();
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
  deps.interaction!.confirm = async () => false;
  await expect(
    prepareInteractiveRequest({ action: "init", repoPath: "/repo" }, deps),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});
test("implicit Production deployment requires explicit branch noninteractively on mismatch and confirmation in TTY", async () => {
  const { deps } = fixture();
  expect(
    await prepareInteractiveRequest({ action: "deploy", target: "live" }, deps),
  ).toMatchObject({ branch: "main" });
  delete deps.interaction;
  await expect(
    prepareInteractiveRequest({ action: "deploy", target: "live" }, deps),
  ).rejects.toMatchObject({ code: "PRODUCTION_CONFIRMATION" });
  expect(
    await prepareInteractiveRequest(
      { action: "deploy", target: "live", branch: "main" },
      deps,
    ),
  ).toMatchObject({ branch: "main" });
});

test("interactive read protocol errors are safe structured daemon failures", async () => {
  const { deps } = fixture();
  deps.client.command = async () => ({ unexpected: "secret-value" });
  await expect(
    prepareInteractiveRequest({ action: "deploy", target: "live" }, deps),
  ).rejects.toMatchObject({ code: "DAEMON_PROTOCOL" });
});

test("cancellation while a context query is pending prevents a deploy request from being prepared", async () => {
  const { deps } = fixture(),
    controller = new AbortController();
  deps.signal = controller.signal;
  deps.client.command = async () => {
    controller.abort();
    return { productionBranch: "main", currentBranch: "main" };
  };
  await expect(
    prepareInteractiveRequest({ action: "deploy", target: "live" }, deps),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});
