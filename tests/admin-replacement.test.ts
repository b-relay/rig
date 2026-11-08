import { expect, test } from "bun:test";
import { recordedAsWanted } from "../src/daemon/admin-replacement";

const wanted = {
  mode: "launchd" as const,
  command: ["/rig/bin/rigd"],
  version: "b",
  bun: "/bun",
  proxy: undefined,
};
test("a record is as wanted only with the same mode, build, command, bun and proxy mode", () => {
  const recorded = {
    mode: "launchd" as const,
    command: ["/rig/bin/rigd"],
    version: "b",
    bun: "/bun",
  };
  expect(recordedAsWanted(recorded, wanted)).toBe(true);
  expect(recordedAsWanted({ ...recorded, proxy: "external" }, wanted)).toBe(
    true,
  );
  expect(recordedAsWanted({ ...recorded, proxy: "managed" }, wanted)).toBe(
    false,
  );
  expect(recordedAsWanted({ ...recorded, mode: "system" }, wanted)).toBe(false);
  expect(recordedAsWanted({ ...recorded, version: "a" }, wanted)).toBe(false);
  expect(
    recordedAsWanted({ ...recorded, command: ["/rig/bin/rigd", "x"] }, wanted),
  ).toBe(false);
  expect(recordedAsWanted({ ...recorded, bun: undefined }, wanted)).toBe(false);
});

test("a record without a command matches only an empty command, and an empty bun is not an absent one", () => {
  const recorded = { mode: "process" as const, version: "b" };
  expect(
    recordedAsWanted(recorded, {
      ...wanted,
      mode: "process",
      command: [],
      bun: undefined,
    }),
  ).toBe(true);
  expect(
    recordedAsWanted(recorded, {
      ...wanted,
      mode: "process",
      command: [],
      bun: "",
    }),
  ).toBe(false);
});
