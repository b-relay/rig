/* Preloaded into every test run: once its last test is done, the run stops what any fixture was left running, whatever
 * ended that fixture's test. An afterAll here runs after every file, and, unlike a test's own hooks, also after concurrent
 * tests. The sweep closes making fixtures, and only a test, or a repeated run of the tests, starting opens it again: each
 * of those has this afterAll after it. */
import { afterAll, beforeAll, beforeEach } from "bun:test";
import { openFixtures, stopAbandonedFixtures } from "./rig-fixture";

beforeAll(openFixtures);
beforeEach(openFixtures);
// Room for each abandoned fixture's rig down, rigd uninstall and the waits for what they stop, which run side by side.
afterAll(stopAbandonedFixtures, 180_000);
