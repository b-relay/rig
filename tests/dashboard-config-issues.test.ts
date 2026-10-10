import { expect, test } from "bun:test";
import { configIssues } from "../src/daemon/server";
import { describeFailure } from "../web/lib/outcome";
import { RigError } from "../src/domain/errors";

test("a config validation failure passes each field's problem on, and nothing else", () => {
  expect(
    configIssues({
      issues: [
        {
          path: ["services", "api", "ports", "http"],
          message: "must be at most 65535",
        },
        { path: [], message: "bad" },
        { nope: true },
        "junk",
      ],
    }),
  ).toEqual([
    {
      path: ["services", "api", "ports", "http"],
      message: "must be at most 65535",
    },
    { path: [], message: "bad" },
  ]);
  expect(configIssues({})).toBeUndefined();
  expect(
    configIssues({ issues: [{ path: "x", message: "y" }] }),
  ).toBeUndefined();
  expect(
    configIssues({
      issues: Array.from({ length: 80 }, (_, index) => ({
        path: [String(index)],
        message: "m",
      })),
    }),
  ).toHaveLength(50);
});

test("the page reads a refusal's field problems as dotted paths beside its code and hint", () => {
  expect(
    describeFailure(
      new RigError(
        "INVALID_CONFIG",
        "Invalid Project configuration.",
        "Fix it.",
        {
          issues: [
            {
              path: ["services", "api", "restart"],
              message: "must be one of always",
            },
            { path: "malformed", message: "skipped" },
          ],
        },
      ),
    ),
  ).toEqual({
    code: "INVALID_CONFIG",
    message: "Invalid Project configuration.",
    hint: "Fix it.",
    issues: [
      { path: "services.api.restart", message: "must be one of always" },
    ],
  });
  expect(describeFailure(new RigError("X", "y", "z"))).not.toHaveProperty(
    "issues",
  );
});
