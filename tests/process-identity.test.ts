import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  processStartTime,
  recordedProcess,
} from "../src/daemon/process-identity";

const IDENTITY = JSON.stringify(
  resolve(import.meta.dir, "../src/daemon/process-identity.ts"),
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
      await inOwnProcess(`
const state = await recordedProcess({ pid: process.pid, startedAt: printed });
process.stdout.write(JSON.stringify({ state, spawns }));`),
    ).toEqual({ state: "running", spawns: 0 });
  },
);

test.skipIf(process.platform !== "darwin")(
  "a record the kernel's answer does not spell is for ps to decide: another locale's is the recorded process, another time's is not",
  async () => {
    expect(
      await inOwnProcess(
        `
const same = await recordedProcess({ pid: process.pid, startedAt: printed });
const other = await recordedProcess({ pid: process.pid, startedAt: "Do  1 Jan 00:00:00 1970" });
process.stdout.write(JSON.stringify({ same, other, asked: spawns }));`,
        { LC_ALL: "de_DE.UTF-8" },
      ),
    ).toEqual({ same: "running", other: "replaced", asked: 2 });
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
