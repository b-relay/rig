import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  processStartTime,
  recordedProcess,
} from "../src/daemon/process-identity";

const IDENTITY = JSON.stringify(
  resolve(import.meta.dir, "../src/daemon/process-identity.ts"),
);
const NATIVE = JSON.stringify(
  resolve(import.meta.dir, "../src/providers/native-process-start.ts"),
);
/** Runs `body` in its own process, since a process's locale and zone are its own from its start (and bun test sets a zone of
 * its own), and answers what it prints. `spawns` counts the processes it starts from then on. */
async function inOwnProcess(body: string, env: Record<string, string> = {}) {
  const script = `
import { processStartTime, recordedProcess } from ${IDENTITY};
const printed = await processStartTime(process.pid);
let spawns = 0;
const spawn = Bun.spawn;
Bun.spawn = (...args) => { spawns++; return spawn(...args); };
${body}
`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
  });
  return JSON.parse(await new Response(child.stdout).text());
}

test.skipIf(process.platform !== "darwin")(
  "a record ps wrote is confirmed without starting a process; each client's discovery of rigd asks this",
  async () => {
    expect(
      await inOwnProcess(
        `
const state = await recordedProcess({ pid: process.pid, startedAt: printed });
process.stdout.write(JSON.stringify({ state, spawns }));`,
        { LC_ALL: "C" },
      ),
    ).toEqual({ state: "running", spawns: 0 });
  },
);

test.skipIf(process.platform !== "darwin")(
  "a record is spelled as ps spells it in this process's locale, so another locale's is confirmed too, and one from another time goes to ps and is refused",
  async () => {
    expect(
      await inOwnProcess(
        `
const same = await recordedProcess({ pid: process.pid, startedAt: printed });
const confirmed = spawns;
const other = await recordedProcess({ pid: process.pid, startedAt: "Do  1 Jan 00:00:00 1970" });
process.stdout.write(JSON.stringify({ same, confirmed, other, asked: spawns }));`,
        { LC_ALL: "de_DE.UTF-8" },
      ),
    ).toEqual({ same: "running", confirmed: 0, other: "replaced", asked: 1 });
  },
);

test.skipIf(process.platform !== "darwin")(
  "under a zone JavaScript's Date reads otherwise than ps, an earlier owner's record of the pid is refused and the current one's is confirmed",
  async () => {
    // Bun's Date takes TZ=GMT-9 as UTC where ps takes it as nine hours ahead: an owner born nine hours earlier reads, here, as
    // the current process does to Date.
    const seen = await inOwnProcess(
      `
const { nativeProcessStart } = await import(${NATIVE});
const born = (await nativeProcessStart()).start(process.pid);
const date = spawn(["/bin/date", "-r", String(born - 9 * 3600), "+%a %b %e %T %Y"], { stdout: "pipe" });
const stale = (await new Response(date.stdout).text()).trim();
const earlier = await recordedProcess({ pid: process.pid, startedAt: stale });
const asked = spawns;
const current = await recordedProcess({ pid: process.pid, startedAt: printed });
process.stdout.write(JSON.stringify({
  earlier,
  asked,
  current,
  spawnsForCurrent: spawns - asked,
  dateReadsAsCurrent: stale === new Date(born * 1000).toString().replace(/^(\\S+) (\\S+) 0?(\\d+) (\\d+) (\\S+).*/, (_, d, m, n, y, t) => \`\${d} \${m} \${n.padStart(2, " ")} \${t} \${y}\`),
}));`,
      { LC_ALL: "C", TZ: "GMT-9" },
    );
    expect(seen).toEqual({
      earlier: "replaced",
      asked: 1,
      current: "running",
      spawnsForCurrent: 0,
      dateReadsAsCurrent: true,
    });
  },
);

test("a process is identified by its start time, so a reused pid is told apart from the recorded process", async () => {
  const startedAt = await processStartTime(process.pid);
  expect(startedAt).toMatch(/\d{4}$/);
  expect(await processStartTime(process.pid)).toBe(startedAt!);
  expect(await processStartTime(2147483647)).toBeUndefined();
  expect(
    await recordedProcess({ pid: process.pid, startedAt: startedAt! }),
  ).toBe("running");
  expect(
    await recordedProcess({
      pid: process.pid,
      startedAt: "Thu Jan  1 00:00:00 1970",
    }),
  ).toBe("replaced");
  expect(await recordedProcess({ pid: process.pid })).toBe("unverified");
  expect(
    await recordedProcess({ pid: 2147483647, startedAt: startedAt! }),
  ).toBe("exited");
});
