import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const ignored = (path: string) =>
  spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: repo })
    .status === 0;

describe(".gitignore", () => {
  test("log files anywhere stay ignored, including a repository-local Rig root's Target logs", () => {
    expect(ignored("logs/rigd.log")).toBe(true);
    expect(ignored(".rig/targets/demo/stable/logs/target.jsonl")).toBe(true);
    expect(ignored("web/logs/next.log")).toBe(true);
  });
  test("the dashboard's Logs routes are not ignored", () => {
    expect(ignored("web/app/projects/[name]/(sections)/logs/page.tsx")).toBe(
      false,
    );
    expect(
      ignored("web/app/projects/[name]/targets/[target]/logs/page.tsx"),
    ).toBe(false);
  });
});
