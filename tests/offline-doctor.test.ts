import { test, expect } from "bun:test";
import { ConfigError } from "../src/config/errors";
import { parseProjectConfig } from "../src/config";
import {
  inspectOfflineHost,
  type DoctorCheck,
  type OfflineHostReads,
} from "../src/daemon/offline-doctor";

const caddyMissing: DoctorCheck = {
  name: "caddy",
  ok: false,
  message: "caddy is not on PATH.",
  reason: "caddy-missing",
  hint: "Install Caddy.",
};

function reads(
  discover: OfflineHostReads["discoverProject"],
): OfflineHostReads & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async inspectHost(root) {
      asked.push(`host:${root}`);
      return [caddyMissing];
    },
    async discoverProject(cwd) {
      asked.push(`project:${cwd}`);
      return await discover(cwd);
    },
  };
}

test("offline doctor reports the host checks and discovery it is given, without touching PATH or the filesystem", async () => {
  const missing = reads(async () => {
    throw new ConfigError("No config.", "missing_config");
  });
  const report = await inspectOfflineHost("/rig-root", "/work/demo", missing);
  expect(report).toMatchObject({
    ok: false,
    note: "Project checks were skipped: rigd is not reachable.",
  });
  expect(report.checks.map((check) => check.name)).toEqual(["rigd", "caddy"]);
  expect(report.checks[1]).toEqual(caddyMissing);
  expect(missing.asked).toEqual(["host:/rig-root", "project:/work/demo"]);

  const invalid = reads(async () => {
    throw new ConfigError(
      "rig.yaml has an invalid value.",
      "invalid",
      {},
      "Fix rig.yaml.",
    );
  });
  expect(
    (await inspectOfflineHost("/rig-root", "/work/demo", invalid)).checks.at(
      -1,
    ),
  ).toEqual({
    name: "project-config",
    ok: false,
    message: "rig.yaml has an invalid value.",
    reason: "config-invalid",
    hint: "Fix rig.yaml.",
  });

  const valid = reads(async (cwd) => ({
    repoPath: cwd,
    document: {
      path: `${cwd}/rig.yaml`,
      revision: "abc",
      config: parseProjectConfig({
        name: "demo",
        tools: { cli: { bin: "bin/cli" } },
      }),
    },
  }));
  expect(
    (await inspectOfflineHost("/rig-root", "/work/demo", valid)).checks.at(-1),
  ).toEqual({
    name: "project-config",
    ok: true,
    message: "Project 'demo' configuration is valid.",
  });
});
