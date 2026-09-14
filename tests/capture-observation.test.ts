import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCaptureObservation } from "../src/providers/capture-observation";

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
