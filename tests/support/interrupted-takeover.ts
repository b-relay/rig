// A rigd that dies while it takes over a released Tool (#343): run as `bun interrupted-takeover.ts <root> <target.json>
// <point>`. It checkpoints the Target, then installs its one Tool, and exits at once at `point`:
//   before  just before the replacement executable is renamed into place;
//   rename  right after that rename, before the ownership record is written;
//   owner   after the ownership record is written, before the receipt.
// Exits 0 only when the install finished without reaching `point`, which a test treats as a failure.
import { copyFile, chmod, mkdir, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTargetEffects } from "../../src/adapters/target-effects";
import type { InstalledComponent } from "../../src/config/types";
import type { TargetRecord } from "../../src/domain/runtime";
import type { ArtifactInstaller } from "../../src/providers/artifact-installer";
import type { Supervisor } from "../../src/providers/contracts";
import { runCommand } from "../../src/providers/command-runner";
import { localActivation } from "./activation-doubles";
import { noRoutes } from "./router-doubles";

const [root, targetFile, point] = process.argv.slice(2) as [
  string,
  string,
  "before" | "rename" | "owner",
];
const target = JSON.parse(readFileSync(targetFile, "utf8")) as TargetRecord;
const tool = target.plan.components[0] as InstalledComponent;
const installer: ArtifactInstaller = {
  async install(request) {
    await mkdir(dirname(request.destination), { recursive: true });
    const temporary = `${request.destination}.next.tmp`;
    await copyFile(join(request.cwd, request.entrypoint), temporary);
    await chmod(temporary, 0o755);
    if (point === "before") process.exit(9);
    await rename(temporary, request.destination);
    if (point === "rename") process.exit(9);
    return { path: request.destination };
  },
  async observe(path) {
    return (await Bun.file(path).exists()) ? "installed" : "missing";
  },
  // Asked for the receipt, once the ownership record is written.
  shimRevision() {
    if (point === "owner") process.exit(9);
    return undefined;
  },
};
const effects = createTargetEffects({
  ...localActivation(),
  root,
  recordingTime: () => "2026-10-11T12:00:00.000Z",
  supervisors: new Map([["child", {} as Supervisor]]),
  run: runCommand,
  installer,
  router: noRoutes(),
  environment: { PATH: process.env.PATH! },
  // The Tool's previous owner is a Target state no longer records: it is released to this one.
  recordedTargets: async () => new Set([target.id]),
});
await effects.checkpoint(target);
await effects.install(tool, target);
process.exit(0);
