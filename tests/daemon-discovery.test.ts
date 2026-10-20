import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { basic, local } from "./support/dashboard-site";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editProjectConfig,
  previewProjectConfig,
  readProjectConfigSource,
} from "../src/config/documents";
import { createConfigEditor } from "../src/daemon/config-editor";
import { connectDaemon } from "../src/daemon/connection";
import { createEnvEditor } from "../src/daemon/env-editor";
import { processStartTime } from "../src/daemon/process-identity";
import { startControlPlane } from "../src/daemon/server";

// The dashboard reaches rigd only for a signed-in request: these calls run as one from a page on this Mac.
mock.module("next/headers", () => ({
  headers: async () => new Headers({ ...local(), authorization: basic() }),
  cookies: async () => ({ get: () => undefined, set() {} }),
}));
const { daemon, editConfig, editEnv } = await import("../web/server/daemon");

/** rig and the dashboard reach rigd through one discovery: the control-plane token goes only to the port of a recorded
 * process verified to still be the one that wrote the record. A loopback listener stands in for whatever holds the
 * recorded port and keeps every request that reached it. */

const TOKEN = "discovery-fixture-token";
let directory: string;
let startedAt: string;
let reply: (path: string) => Response;
const received: { path: string; authorization: string | null }[] = [];
const listener = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    received.push({
      path,
      authorization: request.headers.get("authorization"),
    });
    return reply(path);
  },
});
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rig-discovery-"));
  startedAt = (await processStartTime(process.pid))!;
});
afterAll(async () => {
  await listener.stop(true);
  await rm(directory, { recursive: true, force: true });
});
/** A Rig root whose address record names the listener's port and the given process. */
async function rootRecording(record: {
  pid: number;
  startedAt?: string;
}): Promise<string> {
  const root = await mkdtemp(join(directory, "root-"));
  await mkdir(join(root, "daemon"));
  await mkdir(join(root, "auth"));
  await writeFile(
    join(root, "daemon", "address.json"),
    JSON.stringify({ port: listener.port, instanceId: "fixture", ...record }),
  );
  await writeFile(join(root, "auth", "control-plane.token"), TOKEN);
  return root;
}
/** Every way rig and the dashboard contact rigd: a command, and each of the dashboard's editors. */
const contacts = {
  "rig command": async (root: string) =>
    (await connectDaemon(root)).command({ action: "list" }),
  "dashboard command": async (root: string) =>
    (await daemon(root)).command({ action: "list" }),
  "dashboard config editor": (root: string) =>
    editConfig({ action: "read", project: "demo" }, root),
  "dashboard env editor": (root: string) =>
    editEnv({ action: "read", project: "demo" }, root),
};
const stale = {
  "a pid that has exited": () => ({ pid: 2147483647, startedAt }),
  "a pid now held by another process": () => ({
    pid: process.pid,
    startedAt: "Thu Jan  1 00:00:00 1970",
  }),
  "a record without a start time": () => ({ pid: process.pid }),
};
for (const [record, recorded] of Object.entries(stale))
  for (const [contact, reach] of Object.entries(contacts))
    test(`${contact}: ${record} is a stale record, and its port never receives the token`, async () => {
      reply = () => Response.json({ result: { projects: [] } });
      received.length = 0;
      const root = await rootRecording(recorded());
      await expect(reach(root)).rejects.toMatchObject({
        code: "DAEMON_UNREACHABLE",
        message: expect.stringContaining("its address record is stale"),
      });
      expect(received).toEqual([]);
    });

test("a record whose process is verified reaches rigd with the token, from rig and the dashboard", async () => {
  const configRead = {
    project: "demo",
    configPath: "/repo/rig.yaml",
    revision: "a".repeat(64),
    raw: "name: demo\n",
    config: { name: "demo" },
    fields: [],
  };
  const envRead = {
    project: "demo",
    directory: "/rig/env/demo",
    services: [],
    jobs: [],
    files: [],
  };
  reply = (path) =>
    Response.json({
      result:
        path === "/v1/config"
          ? configRead
          : path === "/v1/env"
            ? envRead
            : { projects: [] },
    });
  received.length = 0;
  const root = await rootRecording({ pid: process.pid, startedAt });
  expect(await contacts["rig command"](root)).toEqual({ projects: [] });
  expect(await contacts["dashboard command"](root)).toEqual({ projects: [] });
  expect(await contacts["dashboard config editor"](root)).toEqual(configRead);
  expect(await contacts["dashboard env editor"](root)).toEqual(envRead);
  expect(received).toEqual(
    ["/v1/command", "/v1/command", "/v1/config", "/v1/env"].map((path) => ({
      path,
      authorization: `Bearer ${TOKEN}`,
    })),
  );
});

test("an editor reply that does not match its action's schema is refused as a protocol failure", async () => {
  const root = await rootRecording({ pid: process.pid, startedAt });
  reply = () => Response.json({ result: { project: "demo", files: "none" } });
  await expect(
    editConfig({ action: "read", project: "demo" }, root),
  ).rejects.toMatchObject({
    code: "DAEMON_PROTOCOL",
    message: "rigd returned an invalid config editor reply.",
  });
  await expect(
    editEnv({ action: "read", project: "demo" }, root),
  ).rejects.toMatchObject({
    code: "DAEMON_PROTOCOL",
    message: "rigd returned an invalid env editor reply.",
  });
  // A refusal must carry a code and a message, and field problems of the shape the config page shows.
  reply = () =>
    Response.json(
      { error: { code: "CONFIG_INVALID", message: "x", issues: [{}] } },
      { status: 422 },
    );
  await expect(
    editConfig({ action: "read", project: "demo" }, root),
  ).rejects.toMatchObject({
    code: "DAEMON_PROTOCOL",
    message: "rigd returned an invalid config editor refusal.",
  });
  reply = () =>
    Response.json(
      {
        error: {
          code: "CONFIG_INVALID",
          message: "rig.yaml is invalid.",
          issues: [{ path: ["services"], message: "Required" }],
        },
      },
      { status: 422 },
    );
  await expect(
    editConfig({ action: "read", project: "demo" }, root),
  ).rejects.toMatchObject({
    code: "CONFIG_INVALID",
    details: { issues: [{ path: ["services"], message: "Required" }] },
  });
});

test("a status read is abandoned when its caller goes away, not held until rigd answers", async () => {
  const root = await rootRecording({ pid: process.pid, startedAt });
  const answer = Promise.withResolvers<void>();
  const slow = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await answer.promise;
      return Response.json({ result: { project: "demo", targets: [] } });
    },
  });
  try {
    await writeFile(
      join(root, "daemon", "address.json"),
      JSON.stringify({
        port: slow.port,
        instanceId: "fixture",
        pid: process.pid,
        startedAt,
      }),
    );
    const client = await connectDaemon(root, { readDeadlineMs: 30_000 });
    const gone = new AbortController();
    const read = client.command(
      { action: "status", project: "demo" },
      gone.signal,
    );
    gone.abort();
    await expect(read).rejects.toMatchObject({ code: "CANCELLED" });
  } finally {
    answer.resolve();
    await slow.stop(true);
  }
});

/** A Rig root recording a real control plane that serves the real config and env editors for one Project, so replies
 * cross JSON as rigd sends them: a value that is undefined in the editor is absent on the wire. */
async function servedEditors() {
  const root = await mkdtemp(join(directory, "served-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await writeFile(
    join(repo, "rig.yaml"),
    "name: demo\nservices:\n  web:\n    command: serve\n",
  );
  const project = { id: "demo-id", name: "demo", repoPath: repo };
  const registered = async (name: string) =>
    name === "demo" ? project : undefined;
  const server = startControlPlane({
    port: 0,
    token: TOKEN,
    instanceId: "served",
    handle: async () => ({}),
    editor: createConfigEditor({
      resolveProject: registered,
      documents: {
        read: readProjectConfigSource,
        preview: previewProjectConfig,
        apply: editProjectConfig,
      },
      exclusive: (_project, operation) => operation(),
    }),
    env: createEnvEditor({
      envRoot: join(root, "env"),
      resolveProject: registered,
      declared: async () => ({ services: ["web"], jobs: [] }),
      exclusive: (_project, operation) => operation(),
      record: async () => {},
      now: () => new Date().toISOString(),
      id: () => crypto.randomUUID(),
    }),
  });
  await mkdir(join(root, "daemon"));
  await mkdir(join(root, "auth"));
  await writeFile(
    join(root, "daemon", "address.json"),
    JSON.stringify({
      port: server.port,
      instanceId: "served",
      pid: process.pid,
      startedAt,
    }),
  );
  await writeFile(join(root, "auth", "control-plane.token"), TOKEN);
  return { root, server };
}

test("the dashboard reads rigd's config previews and applies that add and remove a field, through JSON", async () => {
  const { root, server } = await servedEditors();
  type Edit =
    | { op: "set"; path: string[]; value: string }
    | { op: "remove"; path: string[] };
  const change = async (action: "preview" | "apply", edit: Edit) => {
    const { revision } = await editConfig(
      { action: "read", project: "demo" },
      root,
    );
    return editConfig(
      { action, project: "demo", expectedRevision: revision, patch: [edit] },
      root,
    );
  };
  try {
    const add: Edit = { op: "set", path: ["description"], value: "A pantry." };
    const added = [{ path: "description", after: "A pantry." }];
    expect((await change("preview", add)).diff).toEqual(added);
    expect(await change("apply", add)).toMatchObject({
      applied: true,
      diff: added,
    });
    const remove: Edit = { op: "remove", path: ["description"] };
    const removed = [{ path: "description", before: "A pantry." }];
    expect((await change("preview", remove)).diff).toEqual(removed);
    expect(await change("apply", remove)).toMatchObject({
      applied: true,
      diff: removed,
    });
  } finally {
    await server.stop(true);
  }
});

test("the dashboard reads rigd's env files, writes and reveals, through JSON", async () => {
  const { root, server } = await servedEditors();
  try {
    const before = await editEnv({ action: "read", project: "demo" }, root);
    // A file that does not exist yet carries no mode or problem; the Project's own scope names no Service or role.
    expect(before.files[0]).toEqual({
      scope: {},
      path: join(root, "env", "demo", "all.env"),
      exists: false,
      revision: before.files[0]!.revision,
      keys: [],
    });
    const web = before.files.find(
      (file) => file.scope.service === "web" && !file.scope.role,
    )!;
    expect(
      await editEnv(
        {
          action: "write",
          project: "demo",
          scope: { service: "web" },
          expectedRevision: web.revision,
          changes: [{ op: "set", key: "TOKEN", value: "secret" }],
          actor: "this Mac",
        },
        root,
      ),
    ).toMatchObject({
      scope: { service: "web" },
      exists: true,
      keys: ["TOKEN"],
    });
    expect(
      await editEnv(
        {
          action: "reveal",
          project: "demo",
          scope: { service: "web" },
          key: "TOKEN",
        },
        root,
      ),
    ).toEqual({
      value: "secret",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  } finally {
    await server.stop(true);
  }
});
