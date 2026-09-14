import { test, expect } from "bun:test";
import { renderResult } from "../src/cli/output";
test("a deploy that replaced Previews lists each retirement before its own outcome", () => {
  expect(
    renderResult("deploy", {
      project: "share",
      target: "feature-d-1234abcd",
      outcome: "deployed",
      branch: "feature/d",
      commit: "470a510f7f4c1b2d3e4f5a6b7c8d9e0f1a2b3c4d",
      retired: [{ target: "feature-b-9876fedc", branch: "feature/b", reason: "Preview limit" }],
    }),
  ).toBe(
    "share feature-b-9876fedc retired feature/b (Preview limit)\nshare feature-d-1234abcd deployed feature/d@470a510\n",
  );
});
test("a deploy outcome names the Branch and Commits so a wrong Project is visible at a glance", () => {
  expect(
    renderResult("deploy", {
      project: "share",
      target: "live",
      outcome: "deployed",
      branch: "main",
      commit: "470a510f7f4c1b2d3e4f5a6b7c8d9e0f1a2b3c4d",
      previousCommit: "83496f8dafde3909a7a7121ef496aeae4dacd2ef",
    }),
  ).toBe("share live deployed main@470a510 (was 83496f8)\n");
  expect(
    renderResult("deploy", { project: "share", target: "preview-x", outcome: "deployed", branch: "feat", commit: "1234567890" }),
  ).toBe("share preview-x deployed feat@1234567\n");
  expect(renderResult("up", { project: "share", target: "live", outcome: "started", branch: "main", commit: "1234567890" })).toBe(
    "share live started\n",
  );
});
