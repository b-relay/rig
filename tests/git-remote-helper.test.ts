import { expect, test } from "bun:test";
import { runRemoteHelper } from "../src/git/remote-helper";

async function* input(lines: string[]) {
  yield* lines;
}
test("remote helper advertises push and waits for a final deployment result before acknowledging refs", async () => {
  let output = "";
  let error = "";
  const commands: unknown[] = [];
  let resolved = false;
  const exit = await runRemoteHelper("rig://localhost/example", {
    repoPath: "/repo",
    input: input([
      "capabilities",
      "list for-push",
      "push refs/heads/main:refs/heads/main",
      "",
      "",
    ]),
    output: {
      write(value) {
        output += value;
      },
      error(value) {
        error += value;
      },
    },
    client: {
      async command(command) {
        commands.push(command);
        if (command.action === "status")
          return { project: "example", targets: [] };
        expect(output).not.toContain("ok refs/heads/main");
        resolved = true;
        return { outcome: "deployed" };
      },
    },
    source: {
      async resolve() {
        return "a".repeat(40);
      },
      async verifyBranch() {},
    },
    newOperationId: () => "push-op",
  });
  expect(exit).toBe(0);
  expect(output).toBe("push\noption\n\n\nok refs/heads/main\n\n");
  expect(resolved).toBe(true);
  expect(commands).toContainEqual({
    action: "git-push",
    project: "example",
    repoPath: "/repo",
    branch: "main",
    commit: "a".repeat(40),
    operationId: "push-op",
  });
  expect(error).toContain("example main deployed");
});

test("dry-run and rejected deletions never deploy; destination Branch and force survive protocol conversion", async () => {
  const requests: any[] = [];
  let output = "";
  const dependencies = {
    repoPath: "/repo",
    input: input([]),
    output: {
      write(value: string) {
        output += value;
      },
      error() {},
    },
    client: {
      async command(request: unknown) {
        requests.push(request);
        return { outcome: "deployed" };
      },
    },
    source: {
      async resolve() {
        return "b".repeat(40);
      },
      async verifyBranch() {},
    },
    newOperationId: () => "op",
  };
  expect(
    await runRemoteHelper("rig://localhost/example", {
      ...dependencies,
      input: input([
        "option dry-run true",
        "push refs/heads/main:refs/heads/preview/main",
        "",
        "",
      ]),
    }),
  ).toBe(0);
  expect(requests).toHaveLength(0);
  expect(output).toContain("ok refs/heads/preview/main");
  expect(
    await runRemoteHelper("rig://localhost/example", {
      ...dependencies,
      input: input(["push +refs/heads/main:refs/heads/preview/main", "", ""]),
    }),
  ).toBe(0);
  expect(requests[0]).toMatchObject({
    action: "git-push",
    branch: "preview/main",
    commit: "b".repeat(40),
    force: true,
  });
  const before = requests.length;
  expect(
    await runRemoteHelper("rig://localhost/example", {
      ...dependencies,
      input: input(["push :refs/heads/main", "", ""]),
    }),
  ).toBe(1);
  expect(requests.length).toBe(before);
  expect(
    await runRemoteHelper("rig://elsewhere/example", {
      ...dependencies,
      input: input(["capabilities"]),
    }),
  ).toBe(1);
});

test("failed or acceptance-only daemon replies never acknowledge a successful push", async () => {
  let output = "";
  const dependencies = {
    repoPath: "/repo",
    input: input(["push refs/heads/main:refs/heads/main", "", ""]),
    output: {
      write(value: string) {
        output += value;
      },
      error() {},
    },
    client: {
      async command() {
        return { accepted: true };
      },
    },
    source: {
      async resolve() {
        return "a".repeat(40);
      },
      async verifyBranch() {},
    },
    newOperationId: () => "op-failed",
  };
  expect(await runRemoteHelper("rig://localhost/example", dependencies)).toBe(
    1,
  );
  expect(output).not.toContain("ok refs/heads/main");
  expect(output).toContain("error refs/heads/main");
});

test("advertises only canonical deployment destinations, excluding custom Previews and ambiguous duplicates", async () => {
  const { targetName } = await import("../src/runtime/targets");
  const canonical = targetName({
    target: "preview",
    branch: "feature",
  });
  let output = "";
  const targets = [
    { name: "local", kind: "local", branch: "working", commit: "a".repeat(40) },
    {
      name: "review",
      kind: "preview",
      branch: "review-only",
      commit: "b".repeat(40),
    },
    { name: "live", kind: "live", branch: "main", commit: "c".repeat(40) },
    {
      name: canonical,
      kind: "preview",
      branch: "feature",
      commit: "d".repeat(40),
    },
    {
      name: "review-feature",
      kind: "preview",
      branch: "feature",
      commit: "e".repeat(40),
    },
    {
      name: targetName({
        target: "preview",
        branch: "duplicate",
      }),
      kind: "preview",
      branch: "duplicate",
      commit: "a".repeat(40),
    },
    {
      name: targetName({
        target: "preview",
        branch: "duplicate",
      }),
      kind: "preview",
      branch: "duplicate",
      commit: "b".repeat(40),
    },
  ];
  const code = await runRemoteHelper("rig://localhost/example", {
    repoPath: "/repo",
    input: input(["list for-push", ""]),
    output: {
      write(value) {
        output += value;
      },
      error() {},
    },
    client: {
      async command() {
        return { targets };
      },
    },
    source: {
      async resolve() {
        throw Error("not pushing");
      },
      async verifyBranch() {},
    },
    newOperationId: () => "op",
  });
  expect(code).toBe(0);
  expect(output).toBe(
    `${"c".repeat(40)} refs/heads/main\n${"d".repeat(40)} refs/heads/feature\n\n`,
  );
});

test("list for-push withholds incomplete or transitioning deployments so git sends the push again", async () => {
  const { targetName } = await import("../src/runtime/targets");
  let output = "";
  const targets = [
    { name: "live", kind: "live", branch: "main", commit: "a".repeat(40), deploymentIncomplete: true },
    {
      name: targetName({ target: "preview", branch: "fail1" }),
      kind: "preview",
      branch: "fail1",
      commit: "b".repeat(40),
      transitionPending: true,
    },
    { name: targetName({ target: "preview", branch: "done" }), kind: "preview", branch: "done", commit: "c".repeat(40) },
  ];
  const code = await runRemoteHelper("rig://localhost/example", {
    repoPath: "/repo",
    input: input(["list for-push", ""]),
    output: {
      write(value) {
        output += value;
      },
      error() {},
    },
    client: {
      async command() {
        return { targets };
      },
    },
    source: {
      async resolve() {
        throw Error("not pushing");
      },
      async verifyBranch() {},
    },
    newOperationId: () => "op",
  });
  expect(code).toBe(0);
  expect(output).toBe(`${"c".repeat(40)} refs/heads/done\n\n`);
});

test("an interrupted push names the operation rigd may still be running", async () => {
  let error = "";
  let finish!: (value: unknown) => void;
  const interrupt = new AbortController();
  const run = runRemoteHelper("rig://localhost/example", {
    repoPath: "/repo",
    input: input(["list for-push", "push refs/heads/main:refs/heads/main", "", ""]),
    output: {
      write() {},
      error(value) {
        error += value;
      },
    },
    client: {
      async command(command) {
        if (command.action === "status") return { project: "example", targets: [] };
        return await new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    source: {
      async resolve() {
        return "a".repeat(40);
      },
      async verifyBranch() {},
    },
    newOperationId: () => "push-op",
    interrupt: interrupt.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  interrupt.abort();
  expect(error).toContain("operation push-op");
  expect(error).toContain("rig activity");
  finish({ outcome: "deployed" });
  expect(await run).toBe(0);
});

test("a tag or deletion in a push batch is rejected per ref while the Branch in the same batch still deploys", async () => {
  let output = "";
  const commands: unknown[] = [];
  const code = await runRemoteHelper("rig://localhost/example", {
    repoPath: "/repo",
    input: input([
      "list for-push",
      "push refs/heads/main:refs/heads/main",
      "push refs/tags/v1:refs/tags/v1",
      "push :refs/heads/old",
      "",
      "",
    ]),
    output: {
      write(value) {
        output += value;
      },
      error() {},
    },
    client: {
      async command(command) {
        commands.push(command);
        if (command.action === "status") return { project: "example", targets: [] };
        return { outcome: "deployed" };
      },
    },
    source: {
      async resolve() {
        return "a".repeat(40);
      },
      async verifyBranch() {},
    },
    newOperationId: () => "op",
  });
  expect(code).toBe(1);
  expect(output).toBe(
    "\nok refs/heads/main\nerror refs/tags/v1 Rig deploys Branches only; tags are not pushed.\nerror refs/heads/old Deleting a Branch is unsupported; use rig down --destroy.\n\n",
  );
  expect(commands.filter((c: any) => c.action === "git-push")).toHaveLength(1);
});
