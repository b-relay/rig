import { expect, test } from "bun:test";
import type { TargetRecord } from "../src/domain/runtime";
import {
  killedMessage,
  stopObserver,
  type StopTracking,
} from "../src/runtime/stop-progress";

const live = { id: "t1", name: "live" } as TargetRecord;
const candidate = { id: "t2", name: "live" } as TargetRecord;

test("a SIGKILL an Operation's earlier stop needed stays in its Activity line when a later stop of the same Service finds nothing running", () => {
  const entry: StopTracking = {
    view: {
      operationId: "op",
      action: "deploy",
      phase: "deploying",
      startedAt: "2026-09-27T08:00:00.000Z",
    },
    kills: new Map(),
  };
  const observer = stopObserver(entry, () => "2026-09-27T08:00:10.000Z");
  // A deploy replaces the previous Target, whose web needed SIGKILL.
  observer.stopping(live, "web", 10_000);
  observer.stopped(live, "web", { outcome: "stopped", killed: "timeout" });
  // The new Target then fails to start, and its rollback stops a web that never ran.
  observer.stopping(candidate, "web", 10_000);
  observer.stopped(candidate, "web", { outcome: "unchanged" });

  expect(killedMessage(entry)).toBe("web stopped after timeout (SIGKILL)");
});
