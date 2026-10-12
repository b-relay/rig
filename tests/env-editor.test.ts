import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ABSENT_REVISION,
  editEnvText,
  encodeEnvAssignment,
  envKeys,
  envRevision,
} from "../src/adapters/env-file-edit";
import { parseEnvironmentFile } from "../src/adapters/env-file";
import {
  describeEnvFile,
  envScopeFile,
  writeEnvFile,
} from "../src/adapters/env-store";
import { privateDirectories } from "../src/adapters/env-store";
import {
  createEnvEditor,
  envChangeMessage,
  envScopes,
} from "../src/daemon/env-editor";
import { startControlPlane } from "../src/daemon/server";
import type { OperationRecord } from "../src/domain/runtime";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rig-env-"));
  roots.push(root);
  return root;
}

describe("editing env file text", () => {
  test("a change keeps comments, order and other names; a set replaces the first assignment and drops later ones", () => {
    const text = "# api keys\nexport A=1\nB='two' # note\n\nA=3\n";
    expect(
      editEnvText(text, [
        { op: "set", key: "A", value: "new" },
        { op: "set", key: "C", value: "c" },
      ]),
    ).toBe("# api keys\nA='new'\nB='two' # note\n\nC='c'\n");
    expect(editEnvText(text, [{ op: "remove", key: "A" }])).toBe(
      "# api keys\nB='two' # note\n\n",
    );
    expect(editEnvText("", [{ op: "set", key: "X", value: "" }])).toBe(
      "X=''\n",
    );
    expect(editEnvText("X=1\n", [{ op: "remove", key: "X" }])).toBe("");
    expect(envKeys(text)).toEqual(["A", "B"]);
  });
  test("every value is written so the reader reads it back exactly", () => {
    for (const value of [
      "plain",
      "  spaced  ",
      "has # hash",
      "it's",
      'say "hi"',
      "line\nbreak",
      "back\\slash",
      "it's\\n-literal",
      "C:\\new\nline",
      "",
      "p@ss=w0rd;$HOME",
    ]) {
      const line = encodeEnvAssignment("KEY", value);
      expect(parseEnvironmentFile(line, "test").KEY).toBe(value);
    }
  });
  test("a value with no single-line form and a bad name are refused without the value", () => {
    const secret = "line\u2028-secret";
    let message = "";
    try {
      encodeEnvAssignment("KEY", secret);
    } catch (error) {
      message = `${(error as Error).message} ${JSON.stringify(error)}`;
    }
    expect(message).toContain("KEY");
    expect(message).not.toContain("secret");
    expect(() => encodeEnvAssignment("1BAD", "x")).toThrow(/not a name/);
  });
  test("a revision changes with the text, and a missing file has its own", () => {
    expect(envRevision(undefined)).toBe(ABSENT_REVISION);
    expect(envRevision("A=1\n")).toMatch(/^[a-f0-9]{64}$/);
    expect(envRevision("A=1\n")).not.toBe(envRevision("A=2\n"));
  });
});

describe("writing env files", () => {
  test("a write creates private directories and a 0600 file, atomically, and an older revision is refused", async () => {
    const root = await scratch();
    const path = envScopeFile(join(root, "env"), "demo", {
      service: "web",
      role: "stable",
    });
    expect(path).toBe(join(root, "env", "demo", "web", "stable.env"));
    const created = await writeEnvFile(path, {}, ABSENT_REVISION, [
      { op: "set", key: "TOKEN", value: "s3cret" },
    ]);
    expect(created).toMatchObject({
      exists: true,
      keys: ["TOKEN"],
      mode: 0o600,
    });
    expect((await stat(join(root, "env", "demo", "web"))).mode & 0o777).toBe(
      0o700,
    );
    expect(await readFile(path, "utf8")).toBe("TOKEN='s3cret'\n");
    // No temporary file is left beside it.
    expect(await readdir(join(root, "env", "demo", "web"))).toEqual([
      "stable.env",
    ]);
    await expect(
      writeEnvFile(path, {}, ABSENT_REVISION, [{ op: "remove", key: "TOKEN" }]),
    ).rejects.toMatchObject({ code: "ENV_REVISION_CONFLICT" });
  });
  test("a hand-made file readable by others is written back 0600, and one the reader refuses is not rewritten", async () => {
    const root = await scratch();
    const path = join(root, "all.env");
    await writeFile(path, "A=1\n", { mode: 0o644 });
    const before = await describeEnvFile(path, {});
    expect(before.mode).toBe(0o644);
    const after = await writeEnvFile(path, {}, before.revision, [
      { op: "set", key: "B", value: "2" },
    ]);
    expect(after.mode).toBe(0o600);
    await writeFile(path, "A=1\nnot an assignment\n");
    const broken = await describeEnvFile(path, {});
    expect(broken.problem).toContain("line 2");
    await expect(
      writeEnvFile(path, {}, broken.revision, [
        { op: "set", key: "C", value: "3" },
      ]),
    ).rejects.toMatchObject({ code: "ENV_FILE" });
  });
});

describe("the env editor", () => {
  async function editor() {
    const root = await scratch();
    const recorded: OperationRecord[] = [];
    let id = 0;
    const edit = createEnvEditor({
      envRoot: join(root, "env"),
      async resolveProject(name) {
        return name === "demo" ? { id: "p1", name, repoPath: root } : undefined;
      },
      async services() {
        return ["api", "web"];
      },
      exclusive: (_project, operation) => operation(),
      async record(operation) {
        recorded.push(operation);
      },
      now: () => "2026-10-10T00:00:00.000Z",
      id: () => `op${++id}`,
    });
    return { root, edit, recorded };
  }
  test("scopes cover the Project's and each Service's files, all roles first, in layering order", () => {
    expect(envScopes(["web"])).toEqual([
      {},
      { role: "working" },
      { role: "stable" },
      { role: "preview" },
      { service: "web" },
      { service: "web", role: "working" },
      { service: "web", role: "stable" },
      { service: "web", role: "preview" },
    ]);
  });
  test("read names every file and its keys but no value; reveal answers one value; write records who changed which names", async () => {
    const { edit, recorded, root } = await editor();
    await mkdir(join(root, "env", "demo"), { recursive: true });
    await writeFile(
      join(root, "env", "demo", "all.env"),
      "DB_PASSWORD=hunter2\n",
    );
    const read = (await edit({ action: "read", project: "demo" })) as {
      files: {
        scope: object;
        keys: string[];
        exists: boolean;
        revision: string;
      }[];
      services: string[];
    };
    expect(read.services).toEqual(["api", "web"]);
    expect(read.files).toHaveLength(12);
    expect(read.files[0]).toMatchObject({
      scope: {},
      exists: true,
      keys: ["DB_PASSWORD"],
    });
    expect(JSON.stringify(read)).not.toContain("hunter2");
    expect(
      await edit({
        action: "reveal",
        project: "demo",
        scope: {},
        key: "DB_PASSWORD",
      }),
    ).toEqual({ value: "hunter2" });
    const written = await edit({
      action: "write",
      project: "demo",
      scope: { service: "web", role: "stable" },
      expectedRevision: ABSENT_REVISION,
      changes: [
        { op: "set", key: "API_KEY", value: "very-secret-value" },
        { op: "remove", key: "OLD" },
      ],
      actor: "dashboard (signed in)",
    });
    expect(JSON.stringify(written)).not.toContain("very-secret-value");
    expect(recorded).toEqual([
      {
        id: "op1",
        projectId: "p1",
        project: "demo",
        target: "stable",
        action: "env",
        outcome: "updated",
        occurredAt: "2026-10-10T00:00:00.000Z",
        message:
          "dashboard (signed in) set API_KEY; removed OLD in web/stable.env",
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain("very-secret-value");
  });
  test("a Service rig.yaml does not declare, a path-like name, or a malformed request is refused without echoing it", async () => {
    const { edit } = await editor();
    await expect(
      edit({
        action: "reveal",
        project: "demo",
        scope: { service: "db" },
        key: "A",
      }),
    ).rejects.toMatchObject({ code: "ENV_SCOPE" });
    for (const scope of [
      { service: "../other" },
      { service: "web/../../x" },
      { role: "dev" },
    ])
      await expect(
        edit({ action: "reveal", project: "demo", scope, key: "A" }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const refusal = await edit({
      action: "write",
      project: "demo",
      scope: {},
      expectedRevision: ABSENT_REVISION,
      changes: [{ op: "set", key: "bad key", value: "leaked-value" }],
      actor: "x",
    }).catch((error: Error) => `${error.message} ${JSON.stringify(error)}`);
    expect(refusal).not.toContain("leaked-value");
    await expect(
      edit({ action: "read", project: "nope" }),
    ).rejects.toMatchObject({
      code: "PROJECT_MISSING",
    });
  });
  test("the Activity message names the names once each, and never a value", () => {
    expect(
      envChangeMessage("dashboard (this Mac)", {}, [
        { op: "set", key: "A" },
        { op: "set", key: "A" },
        { op: "remove", key: "B" },
      ]),
    ).toBe("dashboard (this Mac) set A; removed B in all.env");
  });
  test("the control plane serves it at /v1/env behind the token and never echoes a refused body", async () => {
    const { edit } = await editor();
    const server = startControlPlane({
      port: 0,
      token: "t0ken",
      instanceId: "i",
      handle: async () => ({}),
      env: edit,
    });
    try {
      const post = (body: string, token = "t0ken") =>
        fetch(`http://127.0.0.1:${server.port}/v1/env`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body,
        });
      expect(
        (
          await post(
            JSON.stringify({ action: "read", project: "demo" }),
            "wrong",
          )
        ).status,
      ).toBe(401);
      const ok = await post(
        JSON.stringify({ action: "read", project: "demo" }),
      );
      expect(ok.status).toBe(200);
      expect(
        ((await ok.json()) as { result: { project: string } }).result.project,
      ).toBe("demo");
      const bad = await post('{"value":"leaked-value"');
      expect(bad.status).toBe(400);
      expect(await bad.text()).not.toContain("leaked-value");
      const refused = await post(
        JSON.stringify({
          action: "write",
          project: "demo",
          value: "leaked-value",
        }),
      );
      expect(refused.status).toBe(422);
      expect(await refused.text()).not.toContain("leaked-value");
    } finally {
      server.stop(true);
    }
  });
});

describe("env file hardening", () => {
  test("directories that already existed are made private, from the env root down to the file's", async () => {
    const root = await scratch();
    const envRoot = join(root, "env");
    await mkdir(join(envRoot, "demo", "web"), { recursive: true, mode: 0o755 });
    const path = envScopeFile(envRoot, "demo", { service: "web" });
    await writeEnvFile(
      path,
      {},
      ABSENT_REVISION,
      [{ op: "set", key: "A", value: "1" }],
      envRoot,
    );
    for (const directory of [
      envRoot,
      join(envRoot, "demo"),
      join(envRoot, "demo", "web"),
    ])
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(privateDirectories(envRoot, "/elsewhere")).toEqual([]);
    expect(privateDirectories(undefined, envRoot)).toEqual([]);
  });
  test("a symlink below the env root, to a file or a directory, is refused for read, reveal and write", async () => {
    const root = await scratch();
    const envRoot = join(root, "env");
    const outside = join(root, "outside");
    await mkdir(join(outside, "dir"), { recursive: true });
    await writeFile(join(outside, "secret.env"), "A=outside\n", {
      mode: 0o644,
    });
    await writeFile(join(outside, "dir", "all.env"), "B=outside\n");
    const edit = createEnvEditor({
      envRoot,
      async resolveProject(name) {
        return { id: "p1", name, repoPath: root };
      },
      async services() {
        return ["web"];
      },
      exclusive: (_project, operation) => operation(),
      async record() {},
      now: () => "2026-10-10T00:00:00.000Z",
      id: () => "op",
    });
    await mkdir(join(envRoot, "demo"), { recursive: true });
    await symlink(
      join(outside, "secret.env"),
      join(envRoot, "demo", "all.env"),
    );
    await symlink(join(outside, "dir"), join(envRoot, "demo", "web"));
    await expect(edit({ action: "read", project: "demo" })).rejects.toThrow(
      /symlink/,
    );
    await expect(
      edit({ action: "reveal", project: "demo", scope: {}, key: "A" }),
    ).rejects.toThrow(/symlink/);
    await expect(
      edit({
        action: "reveal",
        project: "demo",
        scope: { service: "web" },
        key: "B",
      }),
    ).rejects.toThrow(/symlink/);
    await expect(
      edit({
        action: "write",
        project: "demo",
        scope: {},
        expectedRevision: envRevision("A=outside\n"),
        changes: [{ op: "set", key: "A", value: "x" }],
        actor: "dashboard (this Mac)",
      }),
    ).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, "secret.env"), "utf8")).toBe(
      "A=outside\n",
    );
    expect((await stat(join(outside, "secret.env"))).mode & 0o777).toBe(0o644);
    expect((await stat(join(outside, "dir"))).mode & 0o777).not.toBe(0o700);
  });
  test("an env root that is itself a symlink is allowed", async () => {
    const root = await scratch();
    await mkdir(join(root, "real-env", "demo"), { recursive: true });
    await symlink(join(root, "real-env"), join(root, "env"));
    const edit = createEnvEditor({
      envRoot: join(root, "env"),
      async resolveProject(name) {
        return { id: "p1", name, repoPath: root };
      },
      async services() {
        return [];
      },
      exclusive: (_project, operation) => operation(),
      async record() {},
      now: () => "2026-10-10T00:00:00.000Z",
      id: () => "op",
    });
    await edit({
      action: "write",
      project: "demo",
      scope: {},
      expectedRevision: ABSENT_REVISION,
      changes: [{ op: "set", key: "A", value: "1" }],
      actor: "dashboard (this Mac)",
    });
    expect(
      await readFile(join(root, "real-env", "demo", "all.env"), "utf8"),
    ).toBe("A='1'\n");
  });
  test("__proto__ is refused as a name, since the reader cannot hold it", () => {
    expect(() =>
      editEnvText("", [{ op: "set", key: "__proto__", value: "x" }]),
    ).toThrow(/not a name/);
  });
  test("a Preview file's change names no Target, and a save whose Activity record fails is still a save", async () => {
    const root = await scratch();
    const recorded: OperationRecord[] = [];
    let failRecord = false;
    const edit = createEnvEditor({
      envRoot: join(root, "env"),
      async resolveProject(name) {
        return { id: "p1", name, repoPath: root };
      },
      async services() {
        return [];
      },
      exclusive: (_project, operation) => operation(),
      async record(operation) {
        if (failRecord) throw new Error("disk full");
        recorded.push(operation);
      },
      now: () => "2026-10-10T00:00:00.000Z",
      id: () => "op",
    });
    await edit({
      action: "write",
      project: "demo",
      scope: { role: "preview" },
      expectedRevision: ABSENT_REVISION,
      changes: [{ op: "set", key: "A", value: "1" }],
      actor: "dashboard (this Mac)",
    });
    expect(recorded[0]).not.toHaveProperty("target");
    failRecord = true;
    const read = (await edit({ action: "read", project: "demo" })) as {
      files: { scope: { role?: string }; revision: string }[];
    };
    const revision = read.files.find(
      (each) => each.scope.role === "preview",
    )!.revision;
    expect(
      await edit({
        action: "write",
        project: "demo",
        scope: { role: "preview" },
        expectedRevision: revision,
        changes: [{ op: "set", key: "B", value: "2" }],
        actor: "dashboard (this Mac)",
      }),
    ).toMatchObject({
      keys: ["A", "B"],
      warning: expect.stringContaining("Activity"),
    });
  });
});
