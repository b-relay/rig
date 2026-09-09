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
