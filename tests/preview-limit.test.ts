import { expect, test } from "bun:test";
import type { TargetRecord } from "../src/domain/runtime";
import { previewsToReplace } from "../src/runtime/previews";

/** A recorded Target with only what the Preview limit reads. */
const recorded = (
  name: string,
  createdAt: string,
  extra: Partial<TargetRecord> = {},
): TargetRecord =>
  ({
    id: `id-${name}`,
    projectId: "demo",
    kind: "preview",
    name,
    desired: "running",
    createdAt,
    ...extra,
  }) as TargetRecord;
const oldest = { max: 2, replace_policy: "oldest" } as const;
const none = new Set<string>();
const names = (targets: readonly TargetRecord[]) => targets.map((t) => t.name);

test("under the limit no Preview leaves, and the working and stable Targets never count", () => {
  const targets = [
    recorded("working", "2026-01-01T00:00:00Z", { kind: "working" }),
    recorded("stable", "2026-01-01T00:00:00Z", { kind: "stable" }),
    recorded("a", "2026-01-02T00:00:00Z"),
  ];
  expect(previewsToReplace(targets, none, oldest)).toEqual([]);
  expect(
    previewsToReplace([], none, { max: 1, replace_policy: "reject" }),
  ).toEqual([]);
});

test("at the limit the oldest policy picks an incomplete deploy first, then a stopped Preview, then the oldest running one", () => {
  const running = recorded("running", "2026-01-01T00:00:00Z");
  const stopped = recorded("stopped", "2026-01-03T00:00:00Z", {
    desired: "stopped",
  });
  const incomplete = recorded("incomplete", "2026-01-04T00:00:00Z", {
    deploymentIncomplete: true,
  });
  const policy = { max: 3, replace_policy: "oldest" } as const;
  expect(
    names(previewsToReplace([running, stopped, incomplete], none, policy)),
  ).toEqual(["incomplete"]);
  expect(
    names(
      previewsToReplace([running, stopped, incomplete], none, {
        max: 1,
        replace_policy: "oldest",
      }),
    ),
  ).toEqual(["incomplete", "stopped", "running"]);
  const older = recorded("older", "2025-12-01T00:00:00Z");
  expect(names(previewsToReplace([running, older], none, oldest))).toEqual([
    "older",
  ]);
});

test("the reject policy refuses a new Preview at the limit", () => {
  const targets = [
    recorded("a", "2026-01-01T00:00:00Z"),
    recorded("b", "2026-01-02T00:00:00Z"),
  ];
  expect(() =>
    previewsToReplace(targets, none, { max: 2, replace_policy: "reject" }),
  ).toThrow(expect.objectContaining({ code: "PREVIEW_LIMIT" }));
});

test("a Preview another deploy is creating counts against the limit whether or not it is recorded, and is never chosen", () => {
  const recordedOne = recorded("a", "2026-01-01T00:00:00Z");
  // Being created and not recorded yet: it takes the second place, so the recorded one leaves.
  expect(
    names(previewsToReplace([recordedOne], new Set(["b"]), oldest)),
  ).toEqual(["a"]);
  // Being created and recorded already: counted once.
  expect(previewsToReplace([recordedOne], new Set(["a"]), oldest)).toEqual([]);
  // Only Previews being created could make room.
  expect(() => previewsToReplace([], new Set(["b", "c"]), oldest)).toThrow(
    expect.objectContaining({
      code: "PREVIEW_LIMIT",
      message:
        "The Project's Preview limit is taken by Previews that are being deployed right now.",
    }),
  );
});

test("a chosen Preview in an unresolved transition refuses the deploy", () => {
  const pending = recorded("a", "2026-01-01T00:00:00Z", {
    destructionPending: true,
  });
  const later = recorded("b", "2026-01-02T00:00:00Z");
  expect(() => previewsToReplace([pending, later], none, oldest)).toThrow(
    expect.objectContaining({ code: "DEPLOY_RECOVERY" }),
  );
});
