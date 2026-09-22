import { expect, test } from "bun:test";
import { RIG_BUILD, RIG_VERSION, buildStamp } from "../src/domain/version";

test("a build stamp is the release plus its commit, or dev from source", () => {
  expect(buildStamp("0.1.0", "cb6077187ba5")).toBe("0.1.0+cb6077187ba5");
  expect(buildStamp("0.1.0", undefined)).toBe("0.1.0+dev");
  expect(buildStamp("0.1.0", "  ")).toBe("0.1.0+dev");
  expect(RIG_BUILD.startsWith(`${RIG_VERSION}+`)).toBe(true);
});
