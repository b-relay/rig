import { expect, test } from "bun:test";
import { throttledPublisher } from "../src/providers/capture-observation";

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
