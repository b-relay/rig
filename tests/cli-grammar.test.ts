import { expect, test } from "bun:test";
import type { ProjectStatusReport } from "../src/domain/project-status";
import type { RuntimeCommand } from "../src/daemon/protocol";
import { runRigCli } from "../src/cli/rig";

/** Drives the CLI grammar with an injected client; no daemon, filesystem or terminal. */
function harness(reply: (request: RuntimeCommand) => unknown = () => ({ outcome: "started" })) {
  const requests: RuntimeCommand[] = [];
  let out = "";
  let err = "";
  const deps = {
    root: "/isolated/.rig",
    cwd: "/workspace",
    client: {
      async status(selection: RuntimeCommand): Promise<ProjectStatusReport> {
        requests.push({ ...selection, action: "status" });
        return { project: "demo", targets: [] };
      },
      async command(request: RuntimeCommand) {
        requests.push(request);
        return reply(request);
      },
    },
    output: {
      write(value: string) {
        out += value;
      },
      error(value: string) {
        err += value;
      },
    },
    diagnostics: {
      async record() {
        return { path: "/isolated/.rig/logs/rig/rig.jsonl" };
      },
    },
    wait: async () => {},
    newOperationId: () => "op-1",
  };
  return { deps, requests, out: () => out, err: () => err };
}

test("preview commands reject a Branch positional combined with --deployment instead of acting on the deployment", async () => {
  for (const action of ["up", "down", "restart", "logs"]) {
    const h = harness();
    const args = [action, "preview", "feature-a", "--deployment", "feature-b-1a2b3c4d"];
    if (action === "down") args.push("--destroy");
    expect(await runRigCli(args, h.deps)).toBe(1);
    expect(h.requests).toEqual([]);
    expect(h.err()).toContain("Pass a Preview Branch or --deployment, not both.");
    expect(h.err()).toContain(`rig ${action} preview --deployment <name>`);
  }
});

test("preview commands still accept a Branch alone or --deployment alone", async () => {
  const byBranch = harness();
  expect(await runRigCli(["down", "preview", "feature-a"], byBranch.deps)).toBe(0);
  expect(byBranch.requests[0]).toMatchObject({ action: "down", target: "preview", branch: "feature-a" });
  expect(byBranch.requests[0]).not.toHaveProperty("deployment");
  const byName = harness();
  expect(await runRigCli(["down", "preview", "--deployment", "feature-b-1a2b3c4d"], byName.deps)).toBe(0);
  expect(byName.requests[0]).toMatchObject({ action: "down", target: "preview", deployment: "feature-b-1a2b3c4d" });
  expect(byName.requests[0]).not.toHaveProperty("branch");
});
