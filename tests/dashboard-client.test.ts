import { test, expect } from "bun:test";
import { routeUrl, targetKey, targetSelector } from "../web/lib/target";
import { resolveSettlement, transportFailure } from "../web/lib/reconcile";
import {
  ago,
  servesHost,
  shortCommit,
  targetWarnings,
  toneOf,
} from "../web/lib/present";

test("a Preview is selected by its deployment name, other Targets by their own", () => {
  expect(targetSelector({ kind: "preview", name: "feature-x" })).toEqual({
    target: "preview",
    deployment: "feature-x",
  });
  expect(targetSelector({ kind: "live", name: "prod" })).toEqual({
    target: "prod",
  });
  expect(targetKey({ kind: "preview", name: "feature-x" })).toBe(
    "preview:feature-x",
  );
});

test("a route link carries the scheme Caddy serves it on", () => {
  expect(routeUrl("feat-x.rig.b-relay.com")).toBe(
    "https://feat-x.rig.b-relay.com",
  );
  expect(routeUrl("http://localhost:3000")).toBe("http://localhost:3000");
  expect(servesHost("feat-x.rig.b-relay.com/", "feat-x.rig.b-relay.com")).toBe(
    true,
  );
  expect(servesHost("https://rig.b-relay.com", "feat-x.rig.b-relay.com")).toBe(
    false,
  );
  expect(servesHost(undefined, "rig.b-relay.com")).toBe(false);
});

const operation = {
  operationId: "op-1",
  action: "destroy",
  project: "pantry",
  target: "preview",
};

test("a lost reply waits while the Operation runs, then answers as the command would have", () => {
  expect(
    resolveSettlement({ state: "running" }, operation, "load failed"),
  ).toBeUndefined();
  expect(
    resolveSettlement({ state: "waiting" }, operation, "load failed"),
  ).toBeUndefined();
  expect(
    resolveSettlement(
      {
        state: "finished",
        outcome: "succeeded",
        occurredAt: "2026-09-22T10:00:00Z",
      },
      operation,
      "load failed",
    ),
  ).toEqual({ ok: true, value: { ...operation, outcome: "succeeded" } });
  expect(
    resolveSettlement(
      {
        state: "finished",
        outcome: "failed",
        message: "Caddy refused.",
        occurredAt: "2026-09-22T10:00:00Z",
      },
      operation,
      "load failed",
    ),
  ).toMatchObject({
    ok: false,
    failure: { code: "FAILED", message: "Caddy refused.", operationId: "op-1" },
  });
});

test("an Operation rigd never saw is reported as a lost reply naming the transport error", () => {
  const lost = resolveSettlement(
    { state: "unknown" },
    operation,
    "load failed",
  );
  expect(lost).toMatchObject({
    ok: false,
    failure: { code: "REPLY_LOST", operationId: "op-1" },
  });
  expect(lost && !lost.ok ? lost.failure.message : "").toContain("load failed");
  expect(transportFailure(new TypeError("Failed to fetch"))).toEqual({
    code: "UNREACHABLE",
    message: "Failed to fetch",
    hint: expect.stringContaining("could not reach"),
  });
  expect(transportFailure("gone").message).toBe("gone");
});

test("states and outcomes carry a tone, and unknown words read as idle", () => {
  expect(toneOf("healthy")).toBe("good");
  expect(toneOf("starting")).toBe("busy");
  expect(toneOf("degraded")).toBe("warn");
  expect(toneOf("failed")).toBe("bad");
  expect(toneOf("configured")).toBe("idle");
  expect(toneOf("something-new")).toBe("idle");
});

test("presentation helpers shorten a Commit, date an instant coarsely, and word each Target warning", () => {
  expect(shortCommit("0123456789abcdef")).toBe("0123456789");
  expect(shortCommit(undefined)).toBeUndefined();
  const now = Date.parse("2026-09-22T12:00:00Z");
  const at = (secondsAgo: number) =>
    new Date(now - secondsAgo * 1000).toISOString();
  expect(ago(at(10), now)).toBe("just now");
  expect(ago(at(70), now)).toBe("1 min ago");
  expect(ago(at(600), now)).toBe("10 min ago");
  expect(ago(at(7200), now)).toBe("2 h ago");
  expect(ago(at(172800), now)).toBe("2 d ago");
  expect(ago("never", now)).toBe("never");
  const base = {
    name: "live",
    kind: "live" as const,
    state: "healthy" as const,
    components: [],
  };
  expect(targetWarnings(base)).toEqual([]);
  expect(
    targetWarnings({
      ...base,
      routePublished: false,
      deploymentIncomplete: true,
      transitionPending: true,
      destructionPending: true,
    }),
  ).toHaveLength(4);
});
