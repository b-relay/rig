import { expect, test } from "bun:test";
import { interruptLadder } from "./entry-environment";

test("the first interrupt cancels, the second detaches, and a third ends the process", () => {
  const exits: number[] = [];
  const ladder = interruptLadder((code) => {
    exits.push(code);
  });
  expect(ladder.cancel.aborted).toBe(false);
  ladder.interrupt();
  expect(ladder.cancel.aborted).toBe(true);
  expect(ladder.detach.aborted).toBe(false);
  expect(exits).toEqual([]);
  ladder.interrupt();
  expect(ladder.detach.aborted).toBe(true);
  expect(exits).toEqual([]);
  ladder.interrupt();
  expect(exits).toEqual([130]);
});
