import { describe, expect, test } from "bun:test";
import { createNativeProcessUsageReader } from "../src/providers/native-process-usage";
import {
  cpuTimeSeconds,
  createPsProcessUsageReader,
} from "../src/providers/ps-process-usage";

describe("the ps reader", () => {
  test("ps's cumulative CPU time reads as seconds in each of its forms", () => {
    expect(cpuTimeSeconds("0:01.25")).toBe(1.25);
    expect(cpuTimeSeconds("443:47.77")).toBeCloseTo(26_627.77);
    expect(cpuTimeSeconds("1:02:03.50")).toBeCloseTo(3723.5);
    expect(cpuTimeSeconds("2-01:00:00")).toBe(176_400);
    expect(cpuTimeSeconds("n/a")).toBeUndefined();
  });

  test("a tree holds the root's descendants and the members of groups they lead, even a child whose parent exited", async () => {
    const table = [
      "  1     0     1   10:00.00  9000",
      " 50     1    50    0:01.00   100",
      " 51    50    51    0:02.00   200",
      " 52    51    51    0:03.00   300",
      " 53     1    51    0:04.00   400",
      " 60     1    60    9:00.00  5000",
      "garbage line",
    ].join("\n");
    const reader = createPsProcessUsageReader(async () => ({
      exitCode: 0,
      stdout: table,
      stderr: "",
    }));
    const trees = await reader.read([50, 999]);
    expect([...trees.keys()]).toEqual([50]);
    expect(
      trees
        .get(50)!
        .map((reading) => reading.pid)
        .sort(),
    ).toEqual([50, 51, 52, 53]);
    expect(trees.get(50)!.find((reading) => reading.pid === 52)).toEqual({
      pid: 52,
      cpuNs: 3e9,
      memoryBytes: 300 * 1024,
    });
  });

  test("a process table that cannot be read rejects, so the pass is reported rather than recorded as idle", async () => {
    const reader = createPsProcessUsageReader(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "ps: not permitted",
    }));
    await expect(reader.read([1])).rejects.toMatchObject({
      code: "PROCESS_TABLE_UNREADABLE",
    });
  });
});

describe.skipIf(process.platform !== "darwin")("the native reader", () => {
  test("reads a running tree's CPU time and footprint, including a child, and leaves out a root that is gone", async () => {
    const reader = createNativeProcessUsageReader()!;
    expect(reader.kind).toBe("native");
    const child = Bun.spawn(["/bin/sh", "-c", "while :; do :; done"], {
      stdout: "ignore",
    });
    try {
      await Bun.sleep(300);
      const first = await reader.read([process.pid]);
      await Bun.sleep(300);
      const second = await reader.read([process.pid, 2_147_483_000]);
      expect([...second.keys()]).toEqual([process.pid]);
      const before = first.get(process.pid)!.find((r) => r.pid === child.pid)!;
      const after = second.get(process.pid)!.find((r) => r.pid === child.pid)!;
      expect(after.cpuNs - before.cpuNs).toBeGreaterThan(0.1e9);
      expect(after.memoryBytes).toBeGreaterThan(0);
    } finally {
      child.kill();
      await child.exited;
    }
  });
});
