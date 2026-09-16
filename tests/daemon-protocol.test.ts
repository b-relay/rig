import { test, expect } from "bun:test";
import { commandSchema } from "../src/daemon/protocol";

test("commands carry absolute repository paths only, so rigd never resolves a path against its own working directory", () => {
  expect(
    commandSchema.safeParse({ action: "init", repoPath: "/tmp/demo" }).success,
  ).toBe(true);
  expect(
    commandSchema.safeParse({
      action: "repoint",
      project: "demo",
      newPath: "/tmp/moved",
    }).success,
  ).toBe(true);
  for (const command of [
    { action: "init", repoPath: "demo" },
    { action: "doctor", repoPath: "./demo" },
    { action: "repoint", project: "demo", newPath: "../moved" },
  ]) {
    const parsed = commandSchema.safeParse(command);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("must be an absolute path");
  }
});
