import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { runCommand } from "../src/providers/command-runner";
import { createListenerInspection } from "../src/providers/listener-inspection";
import { probeLocalPort } from "../src/providers/port-probe";
import { loopbackAddress } from "../src/runtime/lifecycle";

/** Listens on each host at a port the OS picks, prints `host port` per listener, then stays alive. */
const LISTENER = `
const { createServer } = require("node:net");
for (const host of process.argv.slice(2)) {
  const server = createServer();
  server.listen(0, host, () => console.log(host + " " + server.address().port));
}
setInterval(() => {}, 1000);
`;

async function listening(
  stream: ReadableStream<Uint8Array>,
  count: number,
): Promise<Record<string, number>> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    text += decoder.decode(chunk);
    if (text.trim().split("\n").length >= count) break;
  }
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => line.split(" "))
      .map(([host, port]) => [host!, Number(port)]),
  );
}

test("real processes: listeners of the owned process and of its descendant are reported with the address they are bound to, and nobody else's are", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-listeners-"));
  const script = join(root, "listen.js");
  await writeFile(script, LISTENER);
  // The shell is the owned process; the listener is its child.
  const owned = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      `"${process.execPath}" "${script}" 127.0.0.1 ::1 0.0.0.0 & wait`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const foreign = Bun.spawn([process.execPath, script, "127.0.0.1"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const ports = await listening(owned.stdout, 3);
    const other = await listening(foreign.stdout, 1);
    const evidence = await createListenerInspection(runCommand).inspect(
      owned.pid,
    );
    if (evidence.state !== "observed") throw new Error(evidence.reason);
    expect(evidence.listeners.every(({ pid }) => pid !== owned.pid)).toBe(true);
    expect(
      evidence.listeners
        .map(({ address, port }) => `${address} ${port}`)
        .sort(),
    ).toEqual(
      [
        `127.0.0.1 ${ports["127.0.0.1"]}`,
        `::1 ${ports["::1"]}`,
        `* ${ports["0.0.0.0"]}`,
      ].sort(),
    );
    expect(
      evidence.listeners.some(({ port }) => port === other["127.0.0.1"]),
    ).toBe(false);
    expect(
      evidence.listeners.map(({ address }) => loopbackAddress(address)),
    ).toContain(false);
  } finally {
    // The group's child outlives the shell unless it is ended too.
    await runCommand({ command: ["/usr/bin/pkill", "-f", script] });
    owned.kill();
    foreign.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("a process that listens on nothing is observed with no listeners; a process that does not exist is unknown", async () => {
  const idle = Bun.spawn(["/bin/sleep", "30"]);
  try {
    const inspection = createListenerInspection(runCommand);
    expect(await inspection.inspect(idle.pid)).toEqual({
      state: "observed",
      listeners: [],
    });
    idle.kill();
    await idle.exited;
    expect(await inspection.inspect(idle.pid)).toMatchObject({
      state: "unknown",
    });
  } finally {
    idle.kill();
  }
}, 20000);

test.each([
  ["ps fails", [{ exitCode: 1, stdout: "", stderr: "" }]],
  [
    "lsof complains",
    [
      { exitCode: 0, stdout: "10 1 10\n", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "lsof: permission denied" },
    ],
  ],
  [
    "lsof answers in a form Rig does not read",
    [
      { exitCode: 0, stdout: "10 1 10\n", stderr: "" },
      { exitCode: 0, stdout: "p10\nnlocalhost\n", stderr: "" },
    ],
  ],
])(
  "an inspection is unknown, never empty, when %s",
  async (_label, answers) => {
    const queue = [...answers];
    const inspection = createListenerInspection(async () => queue.shift()!);
    expect(await inspection.inspect(10)).toMatchObject({ state: "unknown" });
  },
);

test("a runner that throws is an unknown inspection, not a rejection", async () => {
  const inspection = createListenerInspection(async () => {
    throw new Error("spawn failed");
  });
  expect(await inspection.inspect(10)).toEqual({
    state: "unknown",
    reason: "spawn failed",
  });
});

test.each([
  ["127.0.0.1", true],
  ["127.8.9.10", true],
  ["::1", true],
  ["0:0:0:0:0:0:0:1", true],
  ["::ffff:127.0.0.1", true],
  ["*", false],
  ["0.0.0.0", false],
  ["::", false],
  ["fe80::1%lo0", false],
  ["192.168.1.4", false],
  ["::ffff:10.0.0.1", false],
  ["1127.0.0.1", false],
])("loopbackAddress(%s) is %p", (address, local) => {
  expect(loopbackAddress(address)).toBe(local);
});

test("the port probe finds a listener on either loopback family, and says why when there is none", async () => {
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const { port } = server.address() as { port: number };
    try {
      expect(await probeLocalPort(port, new AbortController().signal)).toEqual({
        ready: true,
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await probeLocalPort(port, new AbortController().signal)).toEqual({
      ready: false,
      reason: `port ${port}: ECONNREFUSED`,
    });
  }
  const aborted = new AbortController();
  aborted.abort();
  expect(await probeLocalPort(1, aborted.signal)).toEqual({
    ready: false,
    reason: "port 1: cancelled",
  });
});
