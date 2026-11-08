import { expect, test } from "bun:test";
import {
  daemonStatus,
  servingDaemon,
  unverifiedHint,
} from "../src/daemon/admin-observation";
import { RigError } from "../src/domain/errors";

const address = { pid: 41, instanceId: "a" };

test("a health reply is the serving daemon only when it is the one the address and owner records name", () => {
  const health = {
    pid: 41,
    instanceId: "a",
    version: "1.1.0+dev",
    dashboard: "https://rig.example",
    dashboardProblem: "pending",
  };
  expect(servingDaemon(health, address, undefined)).toEqual({
    pid: 41,
    version: "1.1.0+dev",
    dashboard: "https://rig.example",
    dashboardProblem: "pending",
  });
  expect(servingDaemon(health, address, { pid: 41, instanceId: "a" })).toEqual(
    servingDaemon(health, address, undefined),
  );
  expect(
    servingDaemon({ pid: 41, instanceId: "a" }, address, undefined),
  ).toEqual({ pid: 41 });
  expect(
    servingDaemon({ ...health, instanceId: "b" }, address, undefined),
  ).toBe(undefined);
  expect(servingDaemon({ ...health, pid: 42 }, address, undefined)).toBe(
    undefined,
  );
  expect(servingDaemon(health, address, { pid: 40, instanceId: "a" })).toBe(
    undefined,
  );
  expect(servingDaemon(health, address, { pid: 41, instanceId: "z" })).toBe(
    undefined,
  );
});

test("status warnings come in order: installation, build skew, dashboard, credential", () => {
  const credential = new RigError(
    "DAEMON_TOKEN",
    "The credential is empty.",
    "Reissue it.",
  );
  expect(
    daemonStatus({
      installed: true,
      running: true,
      warnings: ["installed program missing"],
      build: "1.1.0+dev",
      serving: {
        pid: 41,
        version: "1.0.0+old",
        dashboard: "https://rig.example",
        dashboardProblem: "certificate pending",
      },
      credential,
    }),
  ).toEqual({
    installed: true,
    running: true,
    reachable: true,
    version: "1.0.0+old",
    dashboard: "https://rig.example",
    warnings: [
      "installed program missing",
      "rigd 1.0.0+old is serving, but this rigd is 1.1.0+dev; run rigd install to upgrade the daemon.",
      "Dashboard: certificate pending",
      "The credential is empty. Reissue it.",
    ],
  });
});

test("a serving daemon of this build adds no warning, and one reporting no version is of an older version", () => {
  const base = { installed: true, running: true, warnings: [], build: "b" };
  expect(daemonStatus({ ...base, serving: { pid: 1, version: "b" } })).toEqual({
    installed: true,
    running: true,
    reachable: true,
    version: "b",
  });
  expect(daemonStatus({ ...base, serving: { pid: 1 } }).warnings).toEqual([
    "rigd of an older version is serving, but this rigd is b; run rigd install to upgrade the daemon.",
  ]);
  expect(
    daemonStatus({
      installed: false,
      running: false,
      warnings: [],
      build: "b",
    }),
  ).toEqual({ installed: false, running: false, reachable: false });
});

test("the unverified hint names each pid once and both records to remove", () => {
  expect(
    unverifiedHint("/rig", [
      { pid: 7 },
      { pid: 7 },
      { pid: 9, startedAt: "x" },
    ]),
  ).toBe(
    "The recorded daemon pid 7, 9 is alive but was recorded by an older rigd without process identity, so it cannot be verified as rigd. If no rigd is running for this root, remove /rig/daemon/owner.json and /rig/daemon/address.json and retry.",
  );
});
