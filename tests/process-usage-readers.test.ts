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
    const started = "Mon Oct 12 10:00:00 2026";
    // Rows out of order, as a table can list a child before its parent.
    const table = [
      ` 52    51    51    0:03.00   300 ${started}`,
      `  1     0     1   10:00.00  9000 ${started}`,
      ` 53     1    51    0:04.00   400 ${started}`,
      ` 50     1    50    0:01.00   100 ${started}`,
      ` 51    50    51    0:02.00   200 ${started}`,
      ` 60     1    60    9:00.00  5000 ${started}`,
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
      started: Date.parse(started),
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
  test("reads a tree's CPU time and footprint, including a child that leads its own process group, and leaves out a root that is gone", async () => {
    const reader = createNativeProcessUsageReader()!;
    expect(reader.kind).toBe("native");
    // A bounded bit of work in a child that leads its own group, under a shell that waits for it.
    const shell = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        "set -m; /bin/sh -c 'i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done; sleep 5' & wait",
      ],
      { stdout: "ignore" },
    );
    try {
      const deadline = Date.now() + 5000;
      let child: { pid: number; cpuNs: number } | undefined;
      while (Date.now() < deadline && !(child && child.cpuNs > 0)) {
        await Bun.sleep(50);
        const tree = (await reader.read([shell.pid])).get(shell.pid) ?? [];
        child = tree.find((reading) => reading.pid !== shell.pid);
      }
      expect(child?.cpuNs).toBeGreaterThan(0);
      // Never more CPU time than wall time since the child began: a wrong timebase would multiply it.
      expect(child!.cpuNs).toBeLessThan(5.5e9);
      const gone = await reader.read([2_147_483_000]);
      expect(gone.size).toBe(0);
    } finally {
      shell.kill();
      await shell.exited;
    }
  });
});
