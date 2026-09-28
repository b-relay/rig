import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The release the fake backend is cached as. */
export const FAKE_RELEASE = "precompiled-2026-09-21-0cf49cb";
/** A stand-in for the Convex backend binary: `keygen` prints a key, and a run serves `/instance_name` on the interface
 * and ports it is given, records its arguments beside itself, and exits on SIGTERM. */
const FAKE_BACKEND = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === "keygen") {
  process.stdout.write(value("--instance-name") + "|fake-admin-key\\n");
  process.exit(0);
}
appendFileSync(join(import.meta.dir, "runs.jsonl"), JSON.stringify({ args, tz: process.env.TZ ?? null }) + "\\n");
const hostname = value("--interface");
Bun.serve({ hostname, port: Number(value("--port")), fetch: () => new Response(value("--instance-name")) });
Bun.serve({ hostname, port: Number(value("--site-proxy-port")), fetch: () => new Response("site") });
process.on("SIGTERM", () => process.exit(0));
`;
/** A stand-in for bunx: records how convex dev was asked for, then runs until it is stopped. */
const fakeBunx = (log: string) => `#!/bin/sh
echo "$*|$CONVEX_SELF_HOSTED_URL|$CONVEX_DEPLOY_KEY|$PWD" >> "${log}"
trap 'echo stopped >> "${log}"; exit 0' TERM
while :; do sleep 0.05; done
`;
/** A temporary HOME whose Convex cache holds the fake backend, and a bin directory with the fake bunx. Nothing here
 * reaches the network or the real ~/.cache. */
export async function fakeConvexHome() {
  const home = await mkdtemp(join(tmpdir(), "rig-convex-home-"));
  const binaries = join(home, ".cache", "convex", "binaries", FAKE_RELEASE);
  await mkdir(binaries, { recursive: true });
  await writeFile(join(binaries, "convex-local-backend"), FAKE_BACKEND);
  await chmod(join(binaries, "convex-local-backend"), 0o755);
  const bin = join(home, "bin");
  await mkdir(bin);
  const bunxLog = join(home, "bunx.log");
  await writeFile(join(bin, "bunx"), fakeBunx(bunxLog));
  await chmod(join(bin, "bunx"), 0o755);
  return {
    home,
    bin,
    bunxLog,
    /** Each backend run so far: its arguments, and the TZ it was given. */
    async runs(): Promise<{ args: string[]; tz: string | null }[]> {
      const text = await readFile(join(binaries, "runs.jsonl"), "utf8").catch(
        () => "",
      );
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) => JSON.parse(line) as { args: string[]; tz: string | null },
        );
    },
  };
}
