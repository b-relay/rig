import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  installationPolicyKey,
  receiptPath,
} from "../src/adapters/install-receipts";

test("a receipt lives under installed/, named by the digest of its Target and Component", () => {
  expect(receiptPath("/rig", "t1", "cli")).toBe(
    `/rig/installed/${createHash("sha256").update("t1:cli").digest("hex")}.json`,
  );
});

test("the publication policy key covers the workspace, entrypoint, destination, public env and env file paths only", () => {
  const component = {
    entrypoint: "bin/cli",
    env: { A: "1" },
    envFiles: [{ path: "/env/cli.env", required: true }],
  };
  const key = installationPolicyKey("/ws", component, "/rig/bin/cli");
  expect(key).toBe(
    createHash("sha256")
      .update(
        JSON.stringify({
          workspace: "/ws",
          entrypoint: "bin/cli",
          destination: "/rig/bin/cli",
          env: { A: "1" },
          envFiles: ["/env/cli.env"],
        }),
      )
      .digest("hex"),
  );
  // Whether a file is required, never its contents, is no part of the policy.
  expect(
    installationPolicyKey(
      "/ws",
      { ...component, envFiles: [{ path: "/env/cli.env", required: false }] },
      "/rig/bin/cli",
    ),
  ).toBe(key);
  expect(
    installationPolicyKey(
      "/ws",
      { ...component, env: { A: "2" } },
      "/rig/bin/cli",
    ),
  ).not.toBe(key);
  expect(
    installationPolicyKey(
      "/ws",
      { entrypoint: "bin/cli", env: {} },
      "/rig/bin/cli",
    ),
  ).toBe(
    createHash("sha256")
      .update(
        JSON.stringify({
          workspace: "/ws",
          entrypoint: "bin/cli",
          destination: "/rig/bin/cli",
          env: {},
          envFiles: [],
        }),
      )
      .digest("hex"),
  );
});
