import { expect, test } from "bun:test";
import { createOutputQueue } from "../src/providers/output-queue";

/** A queue whose writes each wait until the test lets them finish. */
function fixture(limit = 100) {
  const written: string[][] = [];
  const events: string[] = [];
  const finish: (() => void)[] = [];
  const queue = createOutputQueue<string>({
    limit,
    pause: () => events.push("pause"),
    resume: () => events.push("resume"),
    write: (batch) => {
      written.push([...batch]);
      return new Promise((resolve) => finish.push(resolve));
    },
  });
  /** Lets the write under way finish, and whatever follows it begin. */
  const release = async () => {
    finish.shift()!();
    await Bun.sleep(0);
  };
  return { queue, written, events, finish, release };
}

test("what arrives during a write goes into the next one, whole and in order, and the last promise resolves once all of it is written", async () => {
  const f = fixture();
  void f.queue.add(["a"], 1);
  expect(f.written).toEqual([["a"]]);
  void f.queue.add(["b"], 1);
  const last = f.queue.add(["c", "d"], 2);
  expect(f.written).toEqual([["a"]]);

  let done = false;
  void last.then(() => (done = true));
  await f.release();
  expect(f.written).toEqual([["a"], ["b", "c", "d"]]);
  expect(done).toBe(false);
  await f.release();
  await last;

  // The queue was left idle: the next entry starts a write of its own.
  void f.queue.add(["e"], 1);
  expect(f.written.at(-1)).toEqual(["e"]);
});

test("past its limit a queue holds the pipes once, and lets them go as what waits leaves for the log", async () => {
  const f = fixture(100);
  void f.queue.add(["under way"], 1000);
  // The first batch left for the log at once, so nothing waits yet.
  expect(f.events).toEqual([]);
  void f.queue.add(["a"], 60);
  expect(f.events).toEqual([]);
  void f.queue.add(["b"], 60);
  expect(f.events).toEqual(["pause"]);
  void f.queue.add(["c"], 60);
  expect(f.events).toEqual(["pause"]);
  await f.release();
  expect(f.written.at(-1)).toEqual(["a", "b", "c"]);
  expect(f.events).toEqual(["pause", "resume"]);
  // What waits starts counting from nothing again.
  void f.queue.add(["d"], 60);
  expect(f.events).toEqual(["pause", "resume"]);
});

test("a queue given nothing starts no write", async () => {
  const f = fixture();
  await f.queue.add([], 0);
  expect(f.written).toEqual([]);
  void f.queue.add(["a"], 1);
  expect(f.written).toEqual([["a"]]);
});
