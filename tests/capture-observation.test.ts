import { expect, test } from "bun:test";
import { changePublisher } from "../src/providers/capture-observation";

test("only a change is published, however long a component stays idle, so an idle wrapper writes no file", async () => {
  const writes: unknown[] = [];
  const publish = changePublisher(async (observation, applicationIdentity) => {
    writes.push([observation, applicationIdentity]);
  });
  const running = { state: "running" as const, pid: 7 };
  for (let poll = 0; poll < 1000; poll++) await publish({ ...running }, "id");
  expect(writes).toEqual([[running, "id"]]);
  await publish({ state: "stopped", exitCode: 0 }, undefined);
  await publish({ state: "stopped", exitCode: 0 }, undefined);
  expect(writes).toHaveLength(2);
});

test("evidence that could not be written is tried again at the next look", async () => {
  let failing = true;
  const writes: unknown[] = [];
  const publish = changePublisher(async (observation) => {
    if (failing) throw new Error("disk full");
    writes.push(observation);
  });
  await expect(publish({ state: "running" })).rejects.toThrow("disk full");
  failing = false;
  await publish({ state: "running" });
  expect(writes).toHaveLength(1);
});
