import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCaptureObservation,
  throttledPublisher,
} from "../src/providers/capture-observation";

test("evidence freshness is judged when the file is read, so slow identity inspections cannot turn fresh evidence unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-capture-observation-"));
  try {
    const requestPath = join(root, "job.json");
    const wrapperIdentity = "w".repeat(64);
    const applicationIdentity = "a".repeat(64);
    let clock = 1_000_000;
    const write = (observedAt: number) =>
      writeFile(
        `${requestPath}.observation.json`,
        JSON.stringify({
          wrapperPid: 100,
          wrapperIdentity,
          observedAt,
          applicationIdentity,
          observation: { state: "running", pid: 101 },
        }),
      );
    const read = () =>
      readCaptureObservation({
        requestPath,
        wrapperPid: 100,
        now: () => clock,
        async inspect(pid) {
          clock += 600;
          return pid === 100 ? wrapperIdentity : applicationIdentity;
        },
      });
    await write(clock);
    expect(await read()).toEqual({ state: "running", pid: 101 });
    await write(clock - 1001);
    expect(await read()).toMatchObject({ state: "unknown" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unchanged evidence is republished only at the heartbeat, so an idle component does not rewrite its file every poll", async () => {
  let clock = 0;
  const writes: unknown[] = [];
  const publish = throttledPublisher(
    async (observation, applicationIdentity) => {
      writes.push([observation, applicationIdentity]);
    },
    { heartbeatMs: 250, now: () => clock },
  );
  const running = { state: "running" as const, pid: 7 };
  await publish(running, "id");
  clock = 100;
  await publish(running, "id");
  clock = 200;
  await publish({ ...running }, "id");
  expect(writes).toHaveLength(1);
  clock = 250;
  await publish(running, "id");
  expect(writes).toHaveLength(2);
  clock = 260;
  await publish({ state: "stopped", exitCode: 0 }, undefined);
  expect(writes).toHaveLength(3);
  clock = 270;
  await publish({ state: "stopped", exitCode: 0 }, undefined);
  expect(writes).toHaveLength(3);
});
