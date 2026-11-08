/* Preloaded into every test run: once its last test is done, the run stops what any fixture was left running, whatever
 * ended that fixture's test. An afterAll here runs after every file, and, unlike a test's own hooks, also after concurrent
 * tests. */
import { afterAll } from "bun:test";
import { stopAbandonedFixtures } from "./rig-fixture";

// Room for each abandoned fixture's rig down, rigd uninstall and the waits for what they stop, which run side by side.
afterAll(stopAbandonedFixtures, 180_000);
