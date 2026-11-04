import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wallOnlyClock } from "../src/domain/clock";
import {
  decodeEnvironmentFile,
  parseEnvironmentFile,
  readEnvironmentFile,
} from "../src/adapters/env-file";
import { encodeEnvAssignment } from "../src/adapters/env-file-edit";
import { createEnvEditor } from "../src/daemon/env-editor";
import { parseProjectConfig, resolveTargetPlan } from "../src/config";
import { referenceResolver } from "../src/config/references";
import { asRigError, userCorrectable } from "../src/domain/errors";
import type { OperationRecord } from "../src/domain/runtime";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { createHealthMonitor } from "../src/runtime/health-monitor";
import { runtimeWorld } from "./support/runtime-world";

/** Every value in these tests holds this, so a refusal that quotes one is caught. */
const SECRET = "hunter2-secret";
const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === "string" ? Buffer.from(part) : Buffer.from(part),
    ),
  );
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rig-env-values-"));
  roots.push(root);
  return root;
}
function refusal(action: () => unknown): {
  code: string;
  message: string;
  hint: string;
  details: Record<string, unknown>;
} {
  try {
    action();
  } catch (error) {
    return error as never;
  }
  throw new Error("accepted");
}
const quoted = (failure: unknown) =>
  JSON.stringify([
    (failure as Error).message,
    (failure as { hint?: string }).hint,
    (failure as { details?: unknown }).details,
  ]);

describe("the env-file parser", () => {
  test.each([
    ["unquoted", `TOKEN=${SECRET}\0tail\n`],
    ["single-quoted", `TOKEN='${SECRET}\0tail'\n`],
    ["double-quoted", `TOKEN="${SECRET}\0tail"\n`],
  ])(
    "refuses a NUL in a %s value by name, file and line, never by value",
    (_form, line) => {
      const failure = refusal(() =>
        parseEnvironmentFile(`OK=1\n${line}`, "/work/.env"),
      );
      expect(failure).toMatchObject({
        code: "ENV_VALUE",
        details: { path: "/work/.env", line: 2, key: "TOKEN" },
      });
      expect(failure.message).toContain("TOKEN");
      expect(failure.message).toContain("/work/.env");
      expect(quoted(failure)).not.toContain(SECRET);
      expect(userCorrectable(failure.code)).toBe(true);
    },
  );

  test("refuses an unpaired surrogate by name and line, and keeps a real astral character", () => {
    const failure = refusal(() =>
      parseEnvironmentFile(`TOKEN=${SECRET}\ud800\n`, "/work/.env"),
    );
    expect(failure).toMatchObject({
      code: "ENV_VALUE",
      details: { path: "/work/.env", line: 1, key: "TOKEN" },
    });
    expect(quoted(failure)).not.toContain(SECRET);
    expect(parseEnvironmentFile("TOKEN=a😀b\n", "/work/.env")).toEqual({
      TOKEN: "a😀b",
    });
  });

  test("refuses __proto__ by file and line instead of dropping its value, and keeps other inherited names as own values", () => {
    for (const line of [
      `__proto__=${SECRET}`,
      `export __proto__="${SECRET}"`,
      `  __proto__ = '${SECRET}'`,
    ]) {
      const failure = refusal(() =>
        parseEnvironmentFile(`OK=1\n${line}\n`, "/work/.env"),
      );
      expect(failure).toMatchObject({
        code: "ENV_VALUE",
        details: { path: "/work/.env", line: 2, key: "__proto__" },
      });
      expect(failure.message).toContain("__proto__");
      expect(quoted(failure)).not.toContain(SECRET);
    }
    const values = parseEnvironmentFile(
      "constructor=1\ntoString=2\n__proto=3\n",
      "/work/.env",
    );
    expect(Object.keys(values)).toEqual(["constructor", "toString", "__proto"]);
    expect(values.constructor as unknown).toBe("1");
  });

  test("a NUL in a comment changes no value, so it is no refusal", () => {
    expect(parseEnvironmentFile("# a\0b\nA=1 # c\0d\n", "/work/.env")).toEqual({
      A: "1",
    });
  });
});

describe("reading an env file", () => {
  test.each([
    ["a stray byte", [0xff]],
    ["a truncated sequence", [0xc3]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["an overlong NUL", [0xc0, 0x80]],
  ])(
    "refuses %s by name, file and line, never by value",
    async (_kind, invalid) => {
      const path = join(await scratch(), "app.env");
      await writeFile(
        path,
        bytes("OK=café\n", `TOKEN=${SECRET}`, invalid, "tail\nLATER=1\n"),
      );
      const failure = await readEnvironmentFile(path).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        code: "ENV_VALUE",
        details: { path, line: 2, key: "TOKEN" },
      });
      expect((failure as Error).message).toContain("TOKEN");
      expect(quoted(failure)).not.toContain(SECRET);
    },
  );

  test("bytes on a line that only comments change no value, so a process still reads the file exactly", async () => {
    const path = join(await scratch(), "app.env");
    await writeFile(
      path,
      bytes(
        [0xef, 0xbb, 0xbf],
        "# caf",
        [0xe9],
        "\n  # ",
        [0xff],
        "\nA=caf\u00e9-\ufffd\nB=2\n",
      ),
    );
    expect(await readEnvironmentFile(path)).toEqual({
      A: "caf\u00e9-\ufffd",
      B: "2",
    });
  });

  test.each([
    [
      "beside a comment that has them too",
      bytes("# caf", [0xe9], "\nTOKEN=", SECRET, [0xff], "\n"),
      2,
      "TOKEN",
    ],
    [
      "in a comment after the assignment",
      bytes("A=1\nTOKEN=", SECRET, " # caf", [0xe9], "\n"),
      2,
      "TOKEN",
    ],
    [
      "before a # that does not start the line",
      bytes("A=1\n", [0xff], "# ", SECRET, "\n"),
      2,
      undefined,
    ],
  ])("still refuses invalid bytes %s", async (_where, content, line, key) => {
    const path = join(await scratch(), "app.env");
    await writeFile(path, content);
    const failure = await readEnvironmentFile(path).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "ENV_VALUE",
      details: { path, line, ...(key ? { key } : {}) },
    });
    expect(quoted(failure)).not.toContain(SECRET);
  });

  test("valid Unicode, a BOM, CRLF and escaped line breaks read back exactly", async () => {
    const path = join(await scratch(), "app.env");
    await writeFile(
      path,
      bytes(
        [0xef, 0xbb, 0xbf],
        "UNICODE=café-😀-�\r\n",
        'LINES="one\\ntwo\\r\\nthree"\r\n',
        "SEP='a\tb'\n",
      ),
    );
    expect(await readEnvironmentFile(path)).toEqual({
      UNICODE: "café-😀-�",
      LINES: "one\ntwo\r\nthree",
      SEP: "a\tb",
    });
  });
});

describe("the env editor", () => {
  async function editor() {
    const root = await scratch();
    const recorded: OperationRecord[] = [];
    const path = join(root, "env", "demo", "all.env");
    await mkdir(join(root, "env", "demo"), { recursive: true });
    const edit = createEnvEditor({
      envRoot: join(root, "env"),
      async resolveProject(name) {
        return name === "demo" ? { id: "p1", name, repoPath: root } : undefined;
      },
      async declared() {
        return { services: [], jobs: [] };
      },
      exclusive: (_project, operation) => operation(),
      async record(operation) {
        recorded.push(operation);
      },
      now: () => "2026-11-03T00:00:00.000Z",
      id: () => "op",
    });
    const view = async () =>
      (
        (await edit({ action: "read", project: "demo" })) as {
          files: {
            scope: object;
            exists: boolean;
            keys: string[];
            revision: string;
            problem?: string;
          }[];
        }
      ).files[0]!;
    const write = (expectedRevision: string, key: string, value: string) =>
      edit({
        action: "write",
        project: "demo",
        scope: {},
        expectedRevision,
        actor: "test",
        changes: [{ op: "set", key, value }],
      });
    const reveal = (key: string) =>
      edit({ action: "reveal", project: "demo", scope: {}, key }) as Promise<{
        value: string;
        revision: string;
      }>;
    return { path, recorded, view, write, reveal };
  }
  const failed = (work: Promise<unknown>) =>
    work.then(
      () => {
        throw new Error("accepted");
      },
      (error: unknown) => error,
    );

  test.each([
    ["a NUL", `${SECRET}\0tail`],
    ["an unpaired surrogate", `${SECRET}\ud800tail`],
  ])(
    "refuses %s by name before anything is saved or recorded",
    async (_kind, value) => {
      const { path, recorded, view, write } = await editor();
      const failure = await failed(write("absent", "TOKEN", value));
      expect(failure).toMatchObject({
        code: "ENV_VALUE",
        details: { key: "TOKEN", path },
      });
      expect((failure as Error).message).toContain("TOKEN");
      expect(quoted(failure)).not.toContain(SECRET);
      expect((await view()).exists).toBe(false);
      expect(recorded).toEqual([]);

      await writeFile(path, "A=1\n");
      const { revision } = await view();
      await failed(write(revision, "TOKEN", value));
      expect(await readFile(path, "utf8")).toBe("A=1\n");
      expect(recorded).toEqual([]);
    },
  );

  test("encoding names the key and says why, not the Unicode line separator's reason", () => {
    const nul = refusal(() => encodeEnvAssignment("KEY", `${SECRET}\0`));
    expect(nul.message).toContain("NUL");
    expect(nul.hint).not.toContain("U+2028");
    const surrogate = refusal(() =>
      encodeEnvAssignment("KEY", `${SECRET}\ud800`),
    );
    expect(surrogate.message).toContain("surrogate");
    expect(surrogate.hint).not.toContain("U+2028");
  });

  test.each([
    ["invalid UTF-8", bytes(`TOKEN=${SECRET}`, [0xff], "\n"), "TOKEN"],
    ["a NUL", bytes(`TOKEN=${SECRET}\0tail\n`), "TOKEN"],
    ["__proto__", bytes(`__proto__=${SECRET}\n`), "__proto__"],
  ])(
    "a file holding %s is described as a problem without its value, never revealed, never rewritten",
    async (_kind, content, key) => {
      const { path, recorded, view, write, reveal } = await editor();
      const written = Buffer.concat([bytes("OTHER=1\n"), content]);
      await writeFile(path, written);
      const file = await view();
      expect(file.keys).toEqual(["OTHER", key]);
      expect(file.problem).toContain(key);
      expect(file.problem).toContain("line 2");
      expect(JSON.stringify(file)).not.toContain(SECRET);

      expect(quoted(await failed(reveal("OTHER")))).not.toContain(SECRET);
      if (key !== "__proto__")
        expect(await failed(reveal(key))).toMatchObject({ code: "ENV_VALUE" });

      const refused = await failed(write(file.revision, "OTHER", "2"));
      expect(refused).toMatchObject({
        code: "ENV_VALUE",
        details: { path, line: 2, key },
      });
      expect(quoted(refused)).not.toContain(SECRET);
      expect(await readFile(path)).toEqual(written);
      expect(recorded).toEqual([]);
    },
  );

  test("a file with invalid bytes only in a comment is described and refused for editing, its bytes untouched, while its hint says processes still read it", async () => {
    const { path, recorded, view, write } = await editor();
    const written = bytes("A=1\n# caf", [0xe9], "\n");
    await writeFile(path, written);
    const file = await view();
    expect(file.keys).toEqual(["A"]);
    expect(file.problem).toContain("line 2, in a comment");
    const refused = await failed(write(file.revision, "A", "2"));
    expect(refused).toMatchObject({
      code: "ENV_VALUE",
      details: { path, line: 2 },
    });
    expect(await readFile(path)).toEqual(written);
    expect(recorded).toEqual([]);
    expect(refusal(() => decodeEnvironmentFile(written, path)).hint).toContain(
      "processes still read this file",
    );
  });

  test("a revision is of the file's bytes: files that differ only in invalid bytes have different ones", async () => {
    const { path, view } = await editor();
    await writeFile(path, bytes("TOKEN=a", [0xff], "\n"));
    const first = await view();
    await writeFile(path, bytes("TOKEN=a", [0xfe], "\n"));
    const second = await view();
    expect(first.revision).not.toBe(second.revision);
  });

  test("a valid file keeps the revision of its text, and its values round-trip exactly beside a BOM and CRLF", async () => {
    const { path, recorded, view, write, reveal } = await editor();
    const before = bytes([0xef, 0xbb, 0xbf], "# note café\r\nA=1\r\n");
    await writeFile(path, before);
    const file = await view();
    expect(file.problem).toBeUndefined();
    expect(file.revision).toBe(
      createHash("sha256").update(before).digest("hex"),
    );
    for (const value of [
      "café-😀",
      "� is a real character",
      "line one\nline two\r\nthree",
      `it's "quoted" \\n`,
      "",
    ]) {
      const current = await view();
      await write(current.revision, "VALUE", value);
      expect((await reveal("VALUE")).value).toBe(value);
    }
    expect(await readFile(path, "utf8")).toStartWith("﻿# note café\nA=1\n");
    expect((await reveal("A")).value).toBe("1");
    expect(recorded).toHaveLength(5);
  });
});

describe("values in rig.yaml", () => {
  const plan = (config: Record<string, unknown>) =>
    resolveTargetPlan(
      {
        config: parseProjectConfig({
          name: "app",
          targets: { working: true },
          ...config,
        }),
        target: "working",
        workspacePath: "/work",
        dataRoot: "/data",
        assignedPorts: {},
      },
      { operatorHome: "/home", envRoot: "/env" },
    );
  /** What a refused rig.yaml tells the operator, checked to hold no value. */
  const refusedConfig = (action: () => unknown) => {
    try {
      action();
    } catch (error) {
      const rig = asRigError(error);
      expect(
        JSON.stringify([rig.message, rig.hint, rig.details, error]),
      ).not.toContain(SECRET);
      return rig;
    }
    throw new Error("accepted");
  };

  test.each([
    ["a NUL", `${SECRET}\0tail`],
    ["an unpaired surrogate", `${SECRET}\ud800tail`],
  ])(
    "an environment value holding %s is refused as INVALID_CONFIG by its field, for the Project, a Service and a Job",
    (_kind, value) => {
      for (const [field, config] of [
        [
          "environment.TOKEN",
          {
            environment: { TOKEN: value },
            services: { api: { command: "api" } },
          },
        ],
        [
          "services.api.environment.TOKEN",
          {
            services: {
              api: { command: "api", environment: { TOKEN: value } },
            },
          },
        ],
        [
          "jobs.nightly.environment.TOKEN",
          {
            services: { api: { command: "api" } },
            jobs: {
              nightly: {
                command: "run",
                schedule: "0 3 * * *",
                environment: { TOKEN: value },
              },
            },
          },
        ],
      ] as const) {
        const refused = refusedConfig(() => plan(config));
        expect(refused.code).toBe("INVALID_CONFIG");
        expect(refused.hint).toContain(`Fix ${field}: TOKEN holds`);
      }
    },
  );

  test.each([
    ["a NUL", `${SECRET}\0tail`],
    ["an unpaired surrogate", `${SECRET}\ud800tail`],
  ])(
    "a reference to a setting holding %s is refused as INVALID_CONFIG by both paths, into environment and into a _RIG_ variable alike",
    (_kind, value) => {
      const worker = { command: value };
      for (const [field, api] of [
        [
          "services.api.environment.COPY",
          {
            command: "api",
            environment: { COPY: "${services.worker.command}" },
          },
        ],
        [
          "services.api.command",
          { command: "echo ${services.worker.command}" },
        ],
      ] as const) {
        const refused = refusedConfig(() =>
          plan({ services: { api, worker } }),
        );
        expect(refused.code).toBe("INVALID_CONFIG");
        expect(refused.hint).toContain(`Fix ${field}: Reference`);
        expect(refused.hint).toContain("services.worker.command");
      }
    },
  );

  test.each([
    ["text", "${environment.TOKEN}"],
    ["shell", "echo ${environment.TOKEN}"],
  ] as const)(
    "the resolver names the reference and the field in %s, with its own code",
    (form, written) => {
      const references = referenceResolver(
        { environment: { TOKEN: `${SECRET}\0` } },
        {
          target: "working",
          workspace: "/work",
          host: "",
          url: "",
          data: () => "/data",
          port: () => 4000,
        },
      );
      const failure = refusal(() => references[form](written, "build"));
      expect(failure).toMatchObject({
        code: "unrepresentable_value",
        context: { key: "environment.TOKEN", path: "build" },
      });
      expect(failure.message).not.toContain(SECRET);
    },
  );

  test("ordinary Unicode in environment and references still resolves as written", () => {
    const resolved = plan({
      environment: { NAME: "café-😀-�" },
      services: {
        api: {
          command: "echo ${environment.NAME}",
          environment: { COPY: "${environment.NAME}" },
        },
      },
    });
    expect(resolved.referenceValues).toEqual({
      _RIG_environment_NAME: "café-😀-�",
    });
    expect(
      (resolved.components[0] as { env?: Record<string, string> }).env?.COPY,
    ).toBe("café-😀-�");
  });
});

/** Every file under `directory`, as text. */
async function everything(directory: string): Promise<string> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const texts = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
  );
  return texts.join("\n");
}

/** A running Service with a shell health check that restarts it on failure, whose env file came to hold what Rig now refuses,
 * as an upgrade finds one, through the real runtime, Target effects and health monitor over a scripted supervisor. */
async function runningWorld() {
  const scratchRoot = await scratch();
  const envFile = join(scratchRoot, "web.env");
  await writeFile(envFile, "OTHER=kept\n", { mode: 0o600 });
  const config = parseProjectConfig({
    name: "demo",
    services: {
      web: {
        command: "serve",
        env_file: envFile,
        healthcheck: {
          test: '[ "$OTHER" = "kept" ]',
          interval: "5s",
          retries: 1,
          start_period: "1s",
          on_failure: "restart",
        },
      },
    },
    targets: { working: true },
  });
  const processes = new Map<string, ProcessObservation>();
  const events: string[] = [];
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      events.push("start");
      processes.set(request.key, {
        state: "running",
        pid: 5000 + events.length,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      events.push("stop");
      processes.delete(key);
      return { outcome: "stopped" };
    },
    async shutdown() {},
    async detach() {},
  };
  const timers: { at: number; fire: () => void }[] = [];
  let monitor!: ReturnType<typeof createHealthMonitor>;
  const w = await runtimeWorld({
    name: "env-values-running",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-11-03T08:00:00.000Z",
    readinessDeadlineMs: 300,
    lifecycleObserver: {
      changing: (target, service) => monitor?.invalidate(target.id, service),
      activated: (target, service, incarnation) =>
        monitor?.started(target, service, incarnation),
    },
    dependencies: () => ({
      healthResults: (target: { id: string }, service: string) =>
        monitor?.results(target, service),
    }),
  });
  roots.push(w.root);
  const runtime = w.open();
  monitor = createHealthMonitor({
    store: w.store,
    observations: w.deps.observations,
    clock: wallOnlyClock(() => w.clock.ms),
    id: () => `h${Math.random()}`,
    busy: runtime.targetBusy,
    restart: runtime.restartUnhealthy,
    schedule(delayMs, fire) {
      const timer = { at: w.clock.ms + delayMs, fire };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    async diagnostic() {},
    report: { failed() {}, succeeded() {} },
  });
  await runtime.command({ action: "init", repoPath: w.repo });
  return {
    runtime,
    root: w.root,
    envFile,
    events,
    /** One second of fake time per step: rigd's supervision pass and the health monitor's pass, each settled. */
    async advance(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        w.clock.ms += 1000;
        for (const timer of timers.filter((t) => t.at <= w.clock.ms)) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fire();
        }
        await runtime.supervise();
        await monitor.pass();
        await monitor.idle();
      }
    },
  };
}

describe("a running Target whose env file holds such a value", () => {
  test.each([
    ["invalid UTF-8", bytes(`TOKEN=${SECRET}`, [0xff], "\nOTHER=kept\n")],
    ["__proto__", bytes(`__proto__=${SECRET}\nOTHER=kept\n`)],
    ["a NUL", bytes(`TOKEN=${SECRET}\0\nOTHER=kept\n`)],
  ])(
    "keeps running and healthy with %s, its log says so without the value, and a restart is refused before anything stops",
    async (_kind, content) => {
      const w = await runningWorld();
      await w.runtime.command({
        action: "up",
        project: "demo",
        target: "working",
      });
      await w.advance(2);
      expect(w.events).toEqual(["start"]);

      // What the previous Rig left behind: the file holds it, the process runs, and nothing has looked at it since.
      await writeFile(w.envFile, content, { mode: 0o600 });
      await w.advance(16);
      expect(w.events).toEqual(["start"]);
      const status = JSON.stringify(
        await w.runtime.command({
          action: "status",
          project: "demo",
          target: "working",
        }),
      );
      expect(status).toContain('"healthy"');
      expect(status).not.toContain("unhealthy");

      const restarted = await w.runtime
        .command({ action: "restart", project: "demo", target: "working" })
        .then(
          () => undefined,
          (error: Error) => error,
        );
      expect(restarted).toMatchObject({ code: "ENV_VALUE" });
      expect(quoted(restarted)).not.toContain(SECRET);
      expect(w.events).toEqual(["start"]);

      // The Target log names the file; nothing Rig keeps holds the value.
      const kept = await everything(w.root);
      expect(kept).toContain(`${w.envFile} has`);
      expect(kept).not.toContain(SECRET);
      expect(await readFile(w.envFile)).toEqual(content);
    },
    20_000,
  );
});
