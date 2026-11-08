/* Preloaded into every test run: a test process in which no test has begun or ended for the stall limit says where it is
 * and what it is doing, and is then killed. Bun's own timeouts run on the test's thread, so a file whose thread is
 * blocked, or that waits on something they do not reach, would otherwise hold the run until CI cancels it. The limit is
 * kept by a thread of its own, which still runs when the test's thread does not, and runs from when this preload loads,
 * so a file that stalls while it loads or in its first hooks is caught too. */
import { afterEach, beforeAll, beforeEach } from "bun:test";

/** Longer than any test's or hook's timeout (the dashboard build's ten minutes is the longest) and the fixture sweep's
 * together, so only a file that has stopped making progress reaches it, and well inside CI's limit for the whole run.
 * `RIG_TEST_STALL_MS` replaces it, for the test of this deadline. */
const STALL_MS = Number(process.env.RIG_TEST_STALL_MS ?? 15 * 60_000);
// It never keeps a finished run alive.
const watch = new Worker(new URL("./test-stall-watch.ts", import.meta.url), {
  ref: false,
});
/** The last file seen, in its first hook or a test, and how many of its tests have begun and ended. None is seen until
 * the first file's hooks or tests run; a file's loading is seen only once one of them does. */
let progress: { file?: string; begun: number; ended: number } = {
  begun: 0,
  ended: 0,
};
const report = (step?: "begun" | "ended") => {
  if (step !== "ended" && progress.file !== Bun.main)
    progress = { file: Bun.main, begun: 0, ended: 0 };
  if (step) progress[step] += 1;
  watch.postMessage({ ...progress, at: Date.now(), stallMs: STALL_MS });
};
watch.postMessage({ ...progress, at: Date.now(), stallMs: STALL_MS });
// Once for each file under --parallel, once for the whole run without it.
beforeAll(() => report());
beforeEach(() => report("begun"));
afterEach(() => report("ended"));
