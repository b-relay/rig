import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processLeasePath } from "../src/providers/process-lease";
import { stopLeftBehind } from "./support/left-behind";
import {
  FAKE_PID,
  SPOILED,
  TABLE_SPOILED,
  fakeProcess,
  type Fault,
} from "./support/process-double";
import { rigFixture } from "./support/rig-fixture";

// Sequential on purpose: each test replaces Date.now and process.kill, which every test running beside it would share.

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Runs a fixture's cleanup over a process no real one has (`fakeProcess`), which the root records as its rigd, or leases
 * as a Service rigd ran, or which has the pid and group of a Service the root leases but another birth (a `successor`).
 * `uninstall` is whether `rigd uninstall` succeeds. Answers the failure's lines, the signals sent to the process, and
 * whether the root was kept. */
async function cleanupOver(
  as: "rigd" | "Service" | "successor",
  shown: Parameters<typeof fakeProcess>[0],
  uninstall = true,
) {
  const fake = fakeProcess(shown);
  try {
    const f = await rigFixture({
      commands: {
        rig: ["/usr/bin/true"],
        rigd: [uninstall ? "/usr/bin/true" : "/usr/bin/false"],
      },
      inspect: fake.inspect,
    });
    try {
      if (as === "rigd") {
        await mkdir(join(f.root, "daemon"), { recursive: true });
        await writeFile(
          join(f.root, "daemon", "address.json"),
          JSON.stringify({ pid: fake.pid }),
        );
      } else {
        const key = `fake:${fake.pid}`;
        const leased =
          as === "Service" ? fake.identity : "Fri Jan  2 00:00:00 1970";
        await mkdir(join(f.root, "process-leases"), { recursive: true });
        await writeFile(
          processLeasePath(f.root, key),
          JSON.stringify({
            key,
            pid: fake.pid,
            identity: createHash("sha256")
              .update(`${fake.pid}:${leased}`)
              .digest("hex"),
          }),
        );
      }
      const failure = await f.cleanup().then(
        () => undefined,
        (error: Error) => error.message,
      );
      const kept = await exists(f.base);
      if (kept) expect(failure).toContain(`its root is kept at ${f.base}:`);
      return { lines: failure?.split("\n") ?? [], signals: fake.signals, kept };
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  } finally {
    fake.restore();
  }
}

const pid = FAKE_PID;
const service = `processes ${pid} (/bin/sleep 600) that rigd ran outlived rigd, and were stopped`;
/** Where cleanup reads the process to decide what to do, and what it does with one spoiled read there (`once`), and with
 * every read from there on spoiled (`always`). `from` is the number of the first spoiled read among those asking for the
 * process by pid. */
const points: {
  at: string;
  as: "rigd" | "Service";
  from: number;
  endsOn: NodeJS.Signals[];
  uninstall?: false;
  once: { signals: string[]; says: string };
  always: { signals: string[]; says: string };
}[] = [
  {
    at: "the read of the rigd the root records",
    as: "rigd",
    from: 1,
    endsOn: ["SIGKILL"],
    once: {
      signals: ["SIGKILL"],
      says: `rigd ${pid} did not stop, and was killed`,
    },
    always: {
      signals: [],
      says: `the reads of rigd ${pid}, which the root records, were inconclusive, so nothing shows that it stopped`,
    },
  },
  {
    at: "the read just before rigd's SIGTERM",
    as: "rigd",
    from: 2,
    endsOn: ["SIGTERM", "SIGKILL"],
    uninstall: false,
    once: { signals: ["SIGTERM"], says: "rigd uninstall exited with 1: " },
    always: {
      signals: [],
      says: `rigd ${pid} could not be seen to stop, since the reads of it were inconclusive, and the reads of it just before its SIGKILL were inconclusive, so it was not signalled`,
    },
  },
  {
    at: "a read in the wait for rigd to exit",
    as: "rigd",
    from: 2,
    endsOn: ["SIGKILL"],
    once: {
      signals: ["SIGKILL"],
      says: `rigd ${pid} did not stop, and was killed`,
    },
    always: {
      signals: [],
      says: `rigd ${pid} could not be seen to stop, since the reads of it were inconclusive, and the reads of it just before its SIGKILL were inconclusive, so it was not signalled`,
    },
  },
  {
    at: "the read just before rigd's SIGKILL",
    as: "rigd",
    from: 3,
    endsOn: ["SIGKILL"],
    once: {
      signals: ["SIGKILL"],
      says: `rigd ${pid} did not stop, and was killed`,
    },
    always: {
      signals: [],
      says: `rigd ${pid} did not stop, and the reads of it just before its SIGKILL were inconclusive, so it was not signalled`,
    },
  },
  {
    at: "a read in the wait once rigd was killed",
    as: "rigd",
    from: 4,
    endsOn: [],
    once: {
      signals: ["SIGKILL"],
      says: `rigd ${pid} did not stop, and was killed, but is still running`,
    },
    always: {
      signals: ["SIGKILL"],
      says: `rigd ${pid} did not stop, and was killed, but the reads of it since were inconclusive`,
    },
  },
  // The first read of a Service by pid names it for the report.
  {
    at: "the read just before a Service's SIGTERM",
    as: "Service",
    from: 2,
    endsOn: ["SIGTERM", "SIGKILL"],
    once: { signals: ["SIGTERM"], says: service },
    always: {
      signals: [],
      says: `${service}; the reads of ${pid} were inconclusive, so they were not killed`,
    },
  },
  {
    at: "a read in the wait for a Service to exit",
    as: "Service",
    from: 3,
    endsOn: ["SIGKILL"],
    once: {
      signals: ["SIGTERM", "SIGKILL"],
      says: `${service}; ${pid} had to be killed`,
    },
    always: {
      signals: ["SIGTERM"],
      says: `${service}; the reads of ${pid} were inconclusive, so they were not killed`,
    },
  },
  {
    at: "the read just before a Service's SIGKILL",
    as: "Service",
    from: 4,
    endsOn: ["SIGKILL"],
    once: {
      signals: ["SIGTERM", "SIGKILL"],
      says: `${service}; ${pid} had to be killed`,
    },
    always: {
      signals: ["SIGTERM"],
      says: `${service}; the reads of ${pid} were inconclusive, so they were not killed`,
    },
  },
];

/** Spoils reads by `fault` at the read numbered `from`, alone or from there on as `spoiled` says. */
const spoiledFrom =
  (from: number, fault: Fault, spoiled: "once" | "always") => (read: number) =>
    read === from || (spoiled === "always" && read > from) ? fault : undefined;

for (const point of points)
  for (const [fault, spoiled] of SPOILED)
    test(
      spoiled === "once"
        ? `one ${fault} read at ${point.at} is not taken as proof of anything: cleanup reads again and acts on what it shows`
        : `${fault} reads from ${point.at} on keep the root, name it, and signal nothing they cannot show is the process`,
      async () => {
        const outcome = await cleanupOver(
          point.as,
          {
            command:
              point.as === "rigd" ? "/usr/local/bin/rigd" : "/bin/sleep 600",
            endsOn: point.endsOn,
            fault: spoiledFrom(point.from, fault, spoiled),
          },
          point.uninstall ?? true,
        );
        expect(outcome.kept).toBe(true);
        expect(outcome.lines).toContain(point[spoiled].says);
        expect(outcome.signals).toEqual(point[spoiled].signals);
      },
    );

/** Each look at the process table takes two reads that count, so with none before it spoiled, look `n` starts at read
 * `(n - 1) * 2 + 1` of the table. */
const TABLE_READS_PER_LOOK = 2;
const unreadTable =
  "the reads of the process table were inconclusive, so nothing shows that the processes the leases name have exited";
const stillRuns = `processes ${pid} (/bin/sleep 600) still run in process groups the root's leases name; the fixture signals only those it can tie to a lease`;
/** Where cleanup reads the whole process table to decide what to do, and what it reports and signals with one spoiled
 * read there (`once`), and with every read of the table from there on spoiled (`always`). `look` is which of cleanup's
 * five looks at the table it is: the first ties each leased group to its leader, the next two gather its members while rig
 * down and rigd uninstall run, the fourth finds what outlived rigd, and the last what still runs in a leased group. */
const tablePoints: {
  at: string;
  as: "Service" | "successor";
  look: number;
  endsOn: NodeJS.Signals[];
  once: { signals: string[]; says: string[] };
  always: { signals: string[]; says: string[] };
}[] = [
  {
    at: "the table read that ties a leased group to its leader",
    as: "Service",
    look: 1,
    endsOn: ["SIGTERM", "SIGKILL"],
    once: { signals: ["SIGTERM"], says: [service] },
    always: { signals: [], says: [unreadTable] },
  },
  {
    at: "the table read that finds what outlived rigd",
    as: "Service",
    look: 4,
    endsOn: ["SIGTERM", "SIGKILL"],
    once: { signals: ["SIGTERM"], says: [service] },
    always: { signals: [], says: [unreadTable] },
  },
  // A process with a leased pid and group but another birth is not the fixture's to signal: only this read names it.
  {
    at: "the table read of what still runs in a leased group",
    as: "successor",
    look: 5,
    endsOn: [],
    once: { signals: [], says: [stillRuns] },
    always: { signals: [], says: [unreadTable] },
  },
];

/** Cleanup over the process at `point`, with the table read numbered `from` spoiled by `fault` as `spoiled` says: it keeps
 * the root, reports only what `point` says, and sends only its signals. */
async function spoilTable(
  point: (typeof tablePoints)[number],
  from: number,
  fault: Fault,
  spoiled: "once" | "always",
) {
  const outcome = await cleanupOver(point.as, {
    command: "/bin/sleep 600",
    endsOn: point.endsOn,
    tableFault: spoiledFrom(from, fault, spoiled),
  });
  expect(outcome.kept).toBe(true);
  expect(outcome.lines.slice(1)).toEqual(point[spoiled].says);
  expect(outcome.signals).toEqual(point[spoiled].signals);
}
for (const point of tablePoints) {
  const first = (point.look - 1) * TABLE_READS_PER_LOOK + 1;
  for (const [fault, spoiled] of TABLE_SPOILED)
    test(
      spoiled === "once"
        ? `one ${fault} read at ${point.at} is not taken as proof that a process is gone: cleanup reads the table again and acts on what it shows`
        : `${fault} reads from ${point.at} on keep the root, name it, and signal nothing`,
      () => spoilTable(point, first, fault, spoiled),
    );
  // The first read of the look is whole: what it shows runs, whatever the second leaves out.
  test(`a truncated second read at ${point.at} does not outweigh the first: a process either read shows still runs`, () =>
    spoilTable(point, first + 1, "truncated", "once"));
}

test("a rigd whose pid another process takes while cleanup waits for it to exit is not sent SIGKILL", async () => {
  // The daemon is there at cleanup's first look and at the first of its wait, by when the wait has run out; from then on
  // another process has its pid.
  const outcome = await cleanupOver("rigd", {
    command: "/usr/local/bin/rigd",
    endsOn: ["SIGKILL"],
    birth: (read) =>
      read <= 2 ? "Thu Jan  1 00:00:00 1970" : "Fri Jan  2 00:00:00 1970",
  });
  expect(outcome.kept).toBe(true);
  expect(outcome.lines).toContain(
    `rigd ${pid} did not stop, and its pid no longer names that process, so it was not signalled`,
  );
  expect(outcome.signals).toEqual([]);
});

/** Where `stopLeftBehind` reads a process to decide what to do, and what it does with one spoiled read there (`once`) and
 * with every read from there on spoiled (`always`): the signals it sends, and whether the root is removed or kept with
 * the failure given. `from` is the number of the first spoiled read among those asking for the process by pid. */
const leftBehind: {
  at: string;
  from: number;
  endsOn: NodeJS.Signals[];
  once: { signals: string[]; kept?: string };
  always: { signals: string[] };
}[] = [
  {
    at: "the read just before its SIGTERM",
    from: 1,
    endsOn: ["SIGTERM", "SIGKILL"],
    once: { signals: ["SIGTERM"] },
    always: { signals: [] },
  },
  {
    at: "a read in the wait after its SIGTERM",
    from: 2,
    endsOn: ["SIGKILL"],
    once: { signals: ["SIGTERM", "SIGKILL"] },
    always: { signals: ["SIGTERM"] },
  },
  {
    at: "the read just before its SIGKILL",
    from: 3,
    endsOn: ["SIGKILL"],
    once: { signals: ["SIGTERM", "SIGKILL"] },
    always: { signals: ["SIGTERM"] },
  },
  {
    at: "a read in the wait once it was killed",
    from: 4,
    endsOn: [],
    once: {
      signals: ["SIGTERM", "SIGKILL"],
      kept: `process ${FAKE_PID} is still running`,
    },
    always: { signals: ["SIGTERM", "SIGKILL"] },
  },
];
for (const point of leftBehind)
  for (const [fault, spoiled] of SPOILED)
    test(`a process left behind whose ${spoiled === "once" ? "read" : "reads"} at ${point.at} ${spoiled === "once" ? `is ${fault} once is still stopped by what the next read shows` : `are all ${fault} is signalled only as reads show it, and its root is kept`}`, async () => {
      const work = await mkdtemp(join(tmpdir(), "rig-fixture-left-behind-"));
      const fake = fakeProcess({
        command: "/bin/sleep 600",
        endsOn: point.endsOn,
        fault: spoiledFrom(point.from, fault, spoiled),
      });
      try {
        const failure = await stopLeftBehind(
          [
            {
              base: work,
              processes: [{ pid: fake.pid, identity: fake.identity }],
            },
          ],
          fake.inspect,
        ).then(
          () => undefined,
          (error: Error) => error.message,
        );
        expect(fake.signals).toEqual(point[spoiled].signals);
        const kept =
          spoiled === "always"
            ? `the reads of process ${FAKE_PID} were inconclusive, so it may still run`
            : point.once.kept;
        expect(failure).toBe(
          kept === undefined
            ? undefined
            : `${kept}; its root is kept at ${work}`,
        );
        expect(await exists(work)).toBe(kept !== undefined);
      } finally {
        fake.restore();
        await rm(work, { recursive: true, force: true });
      }
    });
