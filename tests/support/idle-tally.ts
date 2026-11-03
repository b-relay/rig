/* Preloaded into a source rigd: counts every process it starts and every read of its runtime state, in the file $IDLE_TALLY. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const tally = { reads: 0, spawns: [] as string[] };
const path = process.env.IDLE_TALLY!;
const save = () => writeFileSync(path, JSON.stringify(tally));
const spawned = (command: readonly string[]) => {
  tally.spawns.push(command.join(" "));
  save();
};
const spawn = childProcess.spawn;
childProcess.spawn = function (
  this: unknown,
  command: string,
  args: string[] = [],
  ...rest: unknown[]
) {
  spawned([command, ...args]);
  return spawn.call(this, command, args, ...rest);
};
syncBuiltinESMExports();
const bunSpawn = Bun.spawn;
(Bun as unknown as { spawn: unknown }).spawn = function (
  command: string[] | { cmd: string[] },
  ...rest: unknown[]
) {
  spawned(Array.isArray(command) ? command : command.cmd);
  return (bunSpawn as (...args: unknown[]) => unknown)(command, ...rest);
};
const { FileStateStore } = await import(
  resolve(import.meta.dir, "../../src/runtime/state-store.ts")
);
const read = FileStateStore.prototype.read;
FileStateStore.prototype.read = function (this: unknown) {
  tally.reads++;
  save();
  return read.call(this);
};
