import { describe, expect, test } from "bun:test";
import { processKey, type ProcessReading } from "../src/domain/usage-sample";
import type { MonitoredProcess } from "../src/runtime/usage-sampler";
import { attributed, hasNewcomer } from "../src/runtime/usage-sampling";

const RIGD = 1;
const CADDY = 2;
const reading = (pid: number, started = 0): ProcessReading => ({
  pid,
  started,
  cpuNs: pid * 1000,
  memoryBytes: pid,
});
const component = (name: string, wrapperPid: number): MonitoredProcess => ({
  wrapperPid,
  series: {
    scope: "component",
    projectId: "p-fletcher",
    project: "fletcher",
    targetId: "t-stable",
    target: "stable",
    targetKind: "stable",
    component: name,
    componentKind: "service",
  },
});
const web = component("web", 10);
const cron = component("cron", 20);
const pids = (readings: readonly ProcessReading[]) =>
  readings.map((each) => each.pid);

describe("whose each reading is", () => {
  test("a Component has what is below its wrapper; Rig itself has rigd, Caddy and the wrappers, each once", () => {
    // rigd's tree holds both wrappers and their Components, as rigd started them.
    const trees = new Map([
      [RIGD, [1, 10, 11, 12, 20, 21].map((pid) => reading(pid))],
      [CADDY, [reading(CADDY)]],
      [10, [10, 11, 12].map((pid) => reading(pid))],
      [20, [20, 21].map((pid) => reading(pid))],
    ]);
    const owners = attributed(
      { processes: [web, cron], rig: [RIGD, CADDY] },
      trees,
    );
    expect(
      owners.components.map((each) => [
        each.series.component,
        pids(each.readings),
      ]),
    ).toEqual([
      ["web", [11, 12]],
      ["cron", [21]],
    ]);
    expect(pids(owners.rig)).toEqual([1, 10, 20, 2]);
  });

  test("a wrapper adopted after a restart, outside rigd's tree, still counts as Rig itself", () => {
    const owners = attributed(
      { processes: [web], rig: [RIGD] },
      new Map([
        [RIGD, [reading(RIGD)]],
        [10, [reading(10), reading(11)]],
      ]),
    );
    expect(pids(owners.components[0]!.readings)).toEqual([11]);
    expect(pids(owners.rig)).toEqual([1, 10]);
  });

  test("a Component with nothing below its wrapper, or no tree at all, is not listed", () => {
    const owners = attributed(
      { processes: [web, cron], rig: [RIGD] },
      new Map([
        [RIGD, [reading(RIGD), reading(10)]],
        [10, [reading(10)]],
      ]),
    );
    expect(owners.components).toEqual([]);
    expect(pids(owners.rig)).toEqual([1, 10]);
  });

  test("with nothing read, nothing is anyone's", () => {
    expect(attributed({ processes: [web], rig: [RIGD] }, new Map())).toEqual({
      components: [],
      rig: [],
    });
  });
});

describe("a newcomer under rigd", () => {
  const known = { processes: [web], rig: [RIGD, CADDY] };

  test("is a process in a Rig tree that is in no Component tree and was not counted as Rig itself", () => {
    const trees = new Map([
      [RIGD, [reading(RIGD), reading(10), reading(11), reading(30)]],
      [CADDY, [reading(CADDY)]],
      [10, [reading(10), reading(11)]],
    ]);
    expect(hasNewcomer(known, trees, new Set())).toBe(true);
    expect(hasNewcomer(known, trees, new Set([processKey(reading(30))]))).toBe(
      false,
    );
  });

  test("is not rigd, Caddy, a wrapper or a Component's process", () => {
    const trees = new Map([
      [RIGD, [reading(RIGD), reading(CADDY), reading(10), reading(11)]],
      [10, [reading(10), reading(11)]],
    ]);
    expect(hasNewcomer(known, trees, new Set())).toBe(false);
  });

  test("is one whose pid was counted as Rig itself before but is now another process", () => {
    const trees = new Map([[RIGD, [reading(RIGD), reading(30, 5)]]]);
    expect(hasNewcomer(known, trees, new Set([processKey(reading(30))]))).toBe(
      true,
    );
  });
});
