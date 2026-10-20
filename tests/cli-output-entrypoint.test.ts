import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startControlPlane } from "../src/daemon/server";
import { processStartTime } from "../src/daemon/process-identity";
import type { RuntimeCommand } from "../src/daemon/protocol";

/** What the real `rig` entrypoint prints for a program reading it: every byte of a large read through a slow pipe, one
 * error document for a read that failed or was interrupted, and an exit for a follow whose reader left while it was
 * quiet. Each case runs the source CLI against a control plane under a fresh RIG_ROOT; no real rigd is contacted. */

const entry = join(import.meta.dir, "../src/index.ts");
/** This process, recorded the way rigd records itself, so discovery can verify it. */
const self = {
  pid: process.pid,
  startedAt: (await processStartTime(process.pid))!,
};

async function fixtureDaemon(
  handle: (command: RuntimeCommand) => Promise<unknown>,
) {
  const directory = await mkdtemp(join(tmpdir(), "rig-output-"));
  const root = join(directory, ".rig");
  const requests: RuntimeCommand[] = [];
  const server = startControlPlane({
    port: 0,
    token: "isolated-output-token",
    instanceId: "output-fixture",
    async handle(command) {
      requests.push(command);
      return await handle(command);
    },
  });
  await mkdir(join(root, "daemon"), { recursive: true });
  await mkdir(join(root, "auth"));
  await writeFile(
    join(root, "daemon/address.json"),
    JSON.stringify({
      port: server.port,
      ...self,
      instanceId: "output-fixture",
    }),
  );
  await writeFile(
    join(root, "auth/control-plane.token"),
    "isolated-output-token",
  );
  return {
    directory,
    root,
    requests,
    async stop() {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
function spawnRig(args: readonly string[], root: string, cwd: string) {
  return Bun.spawn([process.execPath, entry, ...args], {
    cwd,
    env: { ...process.env, RIG_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
}
async function finished(child: ReturnType<typeof spawnRig>) {
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}
/** Runs a bash pipeline with the source rig as $RIG and its working files in $WORK, failing when it outlives `ms`. */
async function pipeline(
  script: string,
  fixture: { root: string; directory: string },
  ms = 20000,
) {
  const child = Bun.spawn(["bash", "-c", script], {
    cwd: fixture.directory,
    env: {
      ...process.env,
      RIG_ROOT: fixture.root,
      RIG: `${process.execPath} ${entry}`,
      WORK: fixture.directory,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      finished(child),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Still running after ${ms} ms: ${script}`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}
/** The reader does not take anything for half a second, so the pipe fills and rig must wait for it rather than fail. */
const SLOW_READER = `$RIG "$@" 2>"$WORK/stderr" | { sleep 0.5; cat; }; echo "\${PIPESTATUS[0]}" >"$WORK/exit"`;
async function throughSlowReader(
  args: readonly string[],
  fixture: { root: string; directory: string },
) {
  const run = await pipeline(
    `set -- ${args.map((arg) => `'${arg}'`).join(" ")}; ${SLOW_READER}`,
    fixture,
  );
  return {
    exit: Number(await readFile(join(fixture.directory, "exit"), "utf8")),
    stdout: run.stdout,
    stderr: await readFile(join(fixture.directory, "stderr"), "utf8"),
  };
}

test("a JSON Lines read larger than the pipe reaches a slow reader whole: every record, in order, one valid object per line", async () => {
  const entries = Array.from({ length: 2000 }, (_, index) => ({
    timestamp: `2026-10-20T12:00:00.${String(index).padStart(4, "0")}Z`,
    component: "api",
    stream: index % 2 ? "stderr" : "stdout",
    line: `line ${index} ${"x".repeat(80)}`,
  }));
  const fixture = await fixtureDaemon(async () => ({
    project: "fixture",
    target: "stable",
    entries,
    cursor: "end",
  }));
  try {
    const read = await throughSlowReader(
      ["logs", "stable", "--project", "fixture", "--json", "--lines", "10000"],
      fixture,
    );
    expect({ exit: read.exit, stderr: read.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    const expected = entries.map((e) => `${JSON.stringify(e)}\n`).join("");
    expect(expected.length).toBeGreaterThan(4 * 65536);
    expect(read.stdout).toBe(expected);
    const lines = read.stdout.split("\n");
    expect(lines.pop()).toBe("");
    expect(lines.map((line) => JSON.parse(line))).toEqual(entries);
  } finally {
    await fixture.stop();
  }
}, 30000);

test("a one-document read larger than the pipe reaches a slow reader as one valid document", async () => {
  const report = {
    projects: Array.from({ length: 3000 }, (_, index) => ({
      name: `project-${index}`,
      repoPath: `/work/project-${index}`,
      targetCount: index % 3,
    })),
  };
  const fixture = await fixtureDaemon(async () => report);
  try {
    const read = await throughSlowReader(["list", "--json"], fixture);
    expect({ exit: read.exit, stderr: read.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect(read.stdout.length).toBeGreaterThan(2 * 65536);
    expect(read.stdout).toBe(`${JSON.stringify(report)}\n`);
  } finally {
    await fixture.stop();
  }
}, 30000);

test("a quiet JSON follow ends once its reader has gone, without a new line to write, and polls no more", async () => {
  const entry = {
    timestamp: "2026-10-20T12:00:00Z",
    component: "api",
    stream: "stdout",
    line: "the only line",
  };
  // A stopped Target: the first page has its retained line, every later page is empty.
  const fixture = await fixtureDaemon(async (command) => ({
    project: "fixture",
    target: "stable",
    entries: command.after ? [] : [entry],
    cursor: "end",
  }));
  try {
    const run = await pipeline(
      `$RIG logs stable --project fixture --json --follow --lines 1 | head -n 1; echo "rig=\${PIPESTATUS[0]}"`,
      fixture,
    );
    expect(run).toEqual({
      exit: 0,
      stdout: `${JSON.stringify(entry)}\nrig=0\n`,
      stderr: "",
    });
    const polls = fixture.requests.length;
    await Bun.sleep(600);
    expect(fixture.requests.length).toBe(polls);
  } finally {
    await fixture.stop();
  }
}, 30000);

test("an interrupted read exits 130 with one CANCELLED document instead of an empty success, while an answered empty read exits 0", async () => {
  const answer = Promise.withResolvers<void>();
  let reply: unknown = { projects: [] };
  const fixture = await fixtureDaemon(async (command) => {
    if (command.action !== "list" || reply === undefined) await answer.promise;
    return reply;
  });
  try {
    expect(
      await finished(
        spawnRig(["list", "--json"], fixture.root, fixture.directory),
      ),
    ).toEqual({ exit: 0, stdout: '{"projects":[]}\n', stderr: "" });
    reply = undefined;
    for (const [args, signal] of [
      [["list", "--json"], "SIGTERM"],
      [["doctor", "--json"], "SIGINT"],
      [["status", "--project", "fixture", "--json"], "SIGTERM"],
    ] as const) {
      const asked = fixture.requests.length;
      const child = spawnRig(args, fixture.root, fixture.directory);
      const result = finished(child);
      // The request has reached rigd, which has not answered.
      while (fixture.requests.length === asked) await Bun.sleep(20);
      child.kill(signal);
      const { exit, stdout, stderr } = await result;
      expect({ args, exit, stdout: JSON.parse(stdout), stderr }).toEqual({
        args,
        exit: 130,
        stdout: {
          error: {
            code: "CANCELLED",
            message:
              "The read was interrupted before rigd answered; nothing was printed.",
            hint: "Run it again.",
          },
        },
        stderr: "",
      });
    }
  } finally {
    answer.resolve();
    await fixture.stop();
  }
}, 30000);

test("doctor, config, proxy and dns list fail as DAEMON_PROTOCOL through the real CLI when rigd answers null", async () => {
  const fixture = await fixtureDaemon(async () => null);
  try {
    for (const args of [["doctor"], ["config"], ["proxy"], ["dns", "list"]]) {
      const run = await finished(
        spawnRig([...args, "--json"], fixture.root, fixture.directory),
      );
      expect({ args, ...run, stdout: JSON.parse(run.stdout) }).toEqual({
        args,
        exit: 1,
        stdout: {
          error: {
            code: "DAEMON_PROTOCOL",
            message: "rigd returned an invalid response.",
            hint: "Check that rig and rigd use the same version.",
          },
        },
        stderr: "",
      });
    }
  } finally {
    await fixture.stop();
  }
}, 30000);

test("a Rig root that cannot be used fails a --json read with one error document on stdout, and is plain text otherwise", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rig-root-output-"));
  const file = join(directory, "root-file");
  const locked = join(directory, "locked");
  await writeFile(file, "not a directory");
  await mkdir(locked);
  await chmod(locked, 0o500);
  const rig = (args: readonly string[], root: string) =>
    finished(
      Bun.spawn([process.execPath, entry, ...args], {
        cwd: directory,
        env: { ...process.env, RIG_ROOT: root },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
  const roots = [
    {
      root: file,
      code: "RIG_ROOT",
      message: `The Rig root ${file} is not a directory.`,
      hint: "Set RIG_ROOT to a directory, or move that file aside.",
    },
    {
      root: "relative/root",
      code: "USAGE",
      message: 'RIG_ROOT must be an absolute path, but it is "relative/root".',
      hint: "Set RIG_ROOT to an absolute directory, or unset it to use ~/.rig.",
    },
    {
      root: join(locked, ".rig"),
      code: "RIG_ROOT",
      message: `The Rig root ${join(locked, ".rig")} cannot be created because ${locked} is not writable.`,
      hint: `Fix its permissions (chmod u+rwx ${locked}), or set RIG_ROOT to a writable directory.`,
    },
  ];
  try {
    for (const { root, ...error } of roots)
      for (const args of [
        ["list", "--json"],
        ["status", "--json"],
        ["logs", "--json"],
        ["proxy", "verify", "--json"],
      ]) {
        const { exit, stdout, stderr } = await rig(args, root);
        expect({ args, exit, stdout: JSON.parse(stdout), stderr }).toEqual({
          args,
          exit: 1,
          stdout: { error },
          stderr: "",
        });
      }
    // Without --json, and for an action, which takes no --json, it stays a plain message on stderr.
    for (const args of [["list"], ["up", "--json"]])
      expect({ args, ...(await rig(args, file)) }).toEqual({
        args,
        exit: 1,
        stdout: "",
        stderr: `${roots[0]!.message}\n${roots[0]!.hint}\n`,
      });
  } finally {
    await chmod(locked, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
