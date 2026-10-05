import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseProjectConfig } from "../src/config";
import { sameConfigDigest } from "../src/config/config-digest";

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("an escaped $${...} literal is text, so the comparison under the old key names keeps it as written", () => {
  const config = parseProjectConfig({
    name: "demo",
    services: { web: { command: "printf '%s' '$${environment.MODE}'" } },
  });
  expect(config).toEqual({
    name: "demo",
    services: { web: { command: "printf '%s' '$${environment.MODE}'" } },
  });
  // The same literal under the old key name is the same config.
  expect(
    sameConfigDigest(
      config,
      sha({
        name: "demo",
        services: { web: { run: "printf '%s' '$${environment.MODE}'" } },
      }),
    ),
  ).toBe(true);
  // A literal that said $${env.MODE} printed other text, so it was a different config.
  expect(
    sameConfigDigest(
      config,
      sha({
        name: "demo",
        services: { web: { run: "printf '%s' '$${env.MODE}'" } },
      }),
    ),
  ).toBe(false);
});
