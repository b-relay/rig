import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { rigFixture } from "./support/rig-fixture";

// The release matrix: the three Project shapes of docs/examples, under the fixed Target names,
// through the public CLI and a real rigd under a temporary RIG_ROOT.

type Fixture = Awaited<ReturnType<typeof rigFixture>>;
interface AppReport {
  greeting: string;
  data: string;
  stored: string;
}

/** An ordinary application: a port and a directory as arguments, one setting from the environment. It knows nothing of Rig. */
const APP = `import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [port, data] = process.argv.slice(2);
mkdirSync(data!, {recursive: true});
const note = join(data!, 'note.txt');
Bun.serve({hostname: '127.0.0.1', port: Number(port), fetch(request) {
  const value = new URL(request.url).searchParams.get('value');
  if (value !== null) writeFileSync(note, value);
  return Response.json({greeting: process.env.GREETING, data, stored: existsSync(note) ? readFileSync(note, 'utf8') : ''});
}});
process.stdout.write('app ready\\n');
`;
const TOOL = "process.stdout.write(`hello ${process.argv[2] ?? ''}\\n`);\n";
const SERVICE = `services:
  web:
    run: "'${process.execPath}' app.ts \${services.web.ports.http} '\${rig.data}/web'"
    ports: { http: auto }
    ready: http://127.0.0.1:\${services.web.ports.http}
    env: { GREETING: from-config }
`;
const TOOLS = `tools:
  hello:
    bin: hello.ts
`;
/** Every Target on; without a targets key only the working Target is. */
const ON = `targets:
  working: true
  stable: true
  preview: true
`;

async function project(f: Fixture, config: string): Promise<string> {
  await f.git(["init", "-b", "main"]);
  await writeFile(join(f.repo, "app.ts"), APP);
  await writeFile(join(f.repo, "hello.ts"), TOOL);
  await writeFile(join(f.repo, "rig.yaml"), `name: demo\n${config}`);
  const commit = await f.commit();
  await f.git(["branch", "feature/x"]);
  expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
  expect(await f.rig(["init"])).toMatchObject({ code: 0 });
  return commit;
}
const text = async (f: Fixture, args: string[]) => {
  const result = await f.rig(args);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return result.stdout;
};
const ok = async (f: Fixture, args: string[]) =>
  JSON.parse(await text(f, [...args, "--json"]));
const refused = async (f: Fixture, args: string[]) => {
  const result = await f.rig(args);
  expect(result.code).toBe(1);
  return result.stdout + result.stderr;
};
const targets = async (f: Fixture) =>
  (await ok(f, ["status"])).targets as {
    name: string;
    kind: string;
    state: string;
    components: { name: string; state: string; port?: number }[];
  }[];
const port = async (f: Fixture, target: string) => {
  const found = (await targets(f))
    .find((entry) => entry.name === target)
    ?.components.find((component) => component.name === "web")?.port;
  expect(found).toBeGreaterThan(0);
  return found!;
};
const app = async (at: number, value?: string): Promise<AppReport> =>
  (await (
    await fetch(
      `http://127.0.0.1:${at}/${value === undefined ? "" : `?value=${value}`}`,
    )
  ).json()) as AppReport;
const closed = (at: number) =>
  expect(
    fetch(`http://127.0.0.1:${at}`, { signal: AbortSignal.timeout(1000) }),
  ).rejects.toThrow();
const tool = async (f: Fixture, name: string) =>
  await f.run([join(f.root, "bin", name), "there"], f.base);

test("one Service with every Target on: config, Doctor, no-up deploy, up, restart, logs, down twice, and a generated Preview whose down keeps its data and whose destroy removes only its own", async () => {
  const f = await rigFixture();
  try {
    const commit = await project(f, ON + SERVICE);
    expect(await text(f, ["config"])).toContain('"run":');
    expect(await text(f, ["doctor", "--project", "demo"])).toContain(
      "No problems found.",
    );

    expect(await ok(f, ["deploy", "stable", "--no-up"])).toMatchObject({
      outcome: "deployed",
      target: "stable",
      commit,
    });
    expect(
      (await targets(f)).find((entry) => entry.name === "stable"),
    ).toMatchObject({ kind: "stable", state: "stopped" });
    expect(await ok(f, ["up", "stable"])).toMatchObject({ outcome: "started" });
    const live = await port(f, "stable");
    expect(await app(live, "stable-record")).toMatchObject({
      greeting: "from-config",
      stored: "stable-record",
    });
    expect(await ok(f, ["restart", "stable"])).toMatchObject({
      outcome: "started",
    });
    expect((await app(await port(f, "stable"))).stored).toBe("stable-record");
    expect(await ok(f, ["up", "working"])).toMatchObject({
      outcome: "started",
    });
    // Another client finds the daemon's process already running, and rigd will not leave it unowned.
    expect(await ok(f, ["up", "working"])).toMatchObject({
      outcome: "unchanged",
    });
    expect((await f.rigd(["uninstall"])).code).toBe(1);

    // A Branch alone names the Preview; Rig generates the Target name.
    const deployed = await ok(f, ["deploy", "preview", "feature/x"]);
    expect(deployed).toMatchObject({
      outcome: "deployed",
      branch: "feature/x",
    });
    expect(deployed.target).toMatch(/^feature-x-[a-f0-9]{8}$/);
    const preview = await app(await port(f, deployed.target), "preview-record");
    expect(
      new Set([
        preview.data,
        (await app(await port(f, "stable"))).data,
        (await app(await port(f, "working"))).data,
      ]).size,
    ).toBe(3);

    // The working and stable Targets cannot be destroyed.
    for (const name of ["working", "stable"])
      expect(await refused(f, ["down", name, "--destroy"])).toContain(
        "Only a Preview can be destroyed.",
      );
    // Outside the repository a Target is selected only with its Project.
    expect((await f.rig(["down", "working"], f.base)).code).toBe(1);
    for (const selector of [
      ["working"],
      ["stable"],
      ["preview", "feature/x"],
    ]) {
      expect(await ok(f, ["down", ...selector])).toMatchObject({
        outcome: "stopped",
      });
      // Down again is a completed no-op, and a stopped Target still has its logs.
      expect((await f.rig(["down", ...selector])).code).toBe(0);
      expect(await text(f, ["logs", ...selector])).toMatch(
        /\d{2}:\d{2}:\d{2}Z  web  > app ready/,
      );
    }
    await closed(live);
    expect((await targets(f)).map((entry) => entry.state)).toEqual([
      "stopped",
      "stopped",
      "stopped",
    ]);

    // Down kept the Preview's data; destroy removes it, and nothing of another Target.
    expect(await readdir(preview.data)).toEqual(["note.txt"]);
    expect(await ok(f, ["up", "preview", "feature/x"])).toMatchObject({
      outcome: "started",
    });
    expect((await app(await port(f, deployed.target))).stored).toBe(
      "preview-record",
    );
    expect(
      await ok(f, ["down", "preview", "feature/x", "--destroy"]),
    ).toMatchObject({ action: "destroy" });
    await expect(readdir(preview.data)).rejects.toThrow();
    expect((await targets(f)).map((entry) => entry.name).sort()).toEqual([
      "stable",
      "working",
    ]);
    expect(await refused(f, ["logs", "preview", "feature/x"])).toContain(
      "feature",
    );
    expect(await ok(f, ["up", "stable"])).toMatchObject({ outcome: "started" });
    expect((await app(await port(f, "stable"))).stored).toBe("stable-record");
    expect(await ok(f, ["down", "stable"])).toMatchObject({
      outcome: "stopped",
    });
    // With every Target stopped rigd uninstalls, and the Targets it recorded stay for the next install.
    expect((await f.rigd(["uninstall"])).code).toBe(0);
    expect(
      JSON.parse(await readFile(join(f.root, "runtime", "state.json"), "utf8"))
        .targets.map((entry: { name: string }) => entry.name)
        .sort(),
    ).toEqual(["stable", "working"]);
  } finally {
    await f.cleanup();
  }
}, 120000);

test("a Tool-only Project: the stable Target publishes the plain command, the working Target <tool>-dev and a generated Preview its own name, and destroying the Preview removes only its command", async () => {
  const f = await rigFixture();
  try {
    await project(f, ON + TOOLS);
    expect(await text(f, ["doctor", "--project", "demo"])).toContain(
      "No problems found.",
    );
    expect(await ok(f, ["deploy", "stable"])).toMatchObject({
      outcome: "deployed",
      target: "stable",
    });
    expect(await ok(f, ["up", "working"])).toMatchObject({ target: "working" });
    const preview = (await ok(f, ["deploy", "preview", "feature/x"]))
      .target as string;
    expect(preview).toMatch(/^feature-x-[a-f0-9]{8}$/);
    for (const name of ["hello", "hello-dev", `hello-${preview}`])
      expect(await tool(f, name)).toMatchObject({
        code: 0,
        stdout: "hello there\n",
      });
    // The names of older Rig versions select nothing.
    for (const name of ["local", "live", "devbox"])
      expect((await f.rig(["up", name])).code).toBe(1);
    for (const name of ["working", "stable"])
      expect(await refused(f, ["down", name, "--destroy"])).toContain(
        "Only a Preview can be destroyed.",
      );
    expect(
      await ok(f, ["down", "preview", "feature/x", "--destroy"]),
    ).toMatchObject({ action: "destroy" });
    expect((await readdir(join(f.root, "bin"))).sort()).toEqual([
      "hello",
      "hello-dev",
    ]);
    for (const name of ["working", "stable"]) {
      expect((await f.rig(["down", name])).code).toBe(0);
      expect((await f.rig(["down", name])).code).toBe(0);
    }
  } finally {
    await f.cleanup();
  }
}, 120000);

test("Services and Tools: a deployed Production Branch reaches the stable Target, and fixture cleanup stops the working Target and a generated Preview it was never told about", async () => {
  const f = await rigFixture();
  try {
    await project(f, ON + SERVICE + TOOLS);
    expect(await ok(f, ["deploy", "stable"])).toMatchObject({
      outcome: "deployed",
    });
    expect((await app(await port(f, "stable"))).greeting).toBe("from-config");
    expect(await tool(f, "hello")).toMatchObject({ code: 0 });
    expect(await text(f, ["logs", "stable"])).toContain("app ready");
    expect(await ok(f, ["down", "stable"])).toMatchObject({
      outcome: "stopped",
    });

    expect(await ok(f, ["up", "working"])).toMatchObject({
      outcome: "started",
    });
    const preview = (await ok(f, ["deploy", "preview", "feature/x"]))
      .target as string;
    expect(await tool(f, "hello-dev")).toMatchObject({ code: 0 });
    expect(await tool(f, `hello-${preview}`)).toMatchObject({ code: 0 });
    const listening = [await port(f, "working"), await port(f, preview)];
    for (const at of listening) expect((await app(at)).greeting).toBeDefined();

    // Both are left running, as a failed assertion would leave them.
    await f.cleanup();
    for (const at of listening) await closed(at);
  } finally {
    await f.cleanup();
  }
}, 120000);

test("the same application runs unchanged by hand: equivalent arguments and environment, no Rig variable, the same answers", async () => {
  const f = await rigFixture();
  const free = () =>
    new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port: found } = server.address() as { port: number };
        server.close(() => resolve(found));
      });
    });
  let manual: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await project(f, SERVICE);
    expect(await ok(f, ["up", "working"])).toMatchObject({
      outcome: "started",
    });
    const managed = await app(await port(f, "working"), "same-record");

    const at = await free(),
      data = await mkdtemp(join(f.base, "by-hand-"));
    // What the mapping in rig.yaml supplies, typed out: one port, one directory, one setting. Nothing of Rig is inherited.
    manual = Bun.spawn([process.execPath, "app.ts", String(at), data], {
      cwd: f.repo,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        GREETING: "from-config",
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await app(at).catch(() => undefined)) break;
      await Bun.sleep(50);
    }
    const byHand = await app(at, "same-record");
    expect({ ...byHand, data: "" }).toEqual({ ...managed, data: "" });
    expect(byHand.data).toBe(data);
    expect(managed.data).toStartWith(f.root.replace(/^\/private/, ""));
    expect(await ok(f, ["down", "working"])).toMatchObject({
      outcome: "stopped",
    });
  } finally {
    manual?.kill();
    await manual?.exited;
    await f.cleanup();
  }
}, 120000);
