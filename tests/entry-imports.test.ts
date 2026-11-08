import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = (path: string) => join(import.meta.dir, "..", "src", path);

/** The modules a fresh Bun process has loaded once it imported `paths`, as paths under src/ or package names. */
async function loaded(...paths: string[]): Promise<string[]> {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `for (const path of ${JSON.stringify(paths)}) await import(path);
       console.log(JSON.stringify(Object.keys(require.cache)));`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const modules = JSON.parse(
    await new Response(child.stdout).text(),
  ) as string[];
  expect(await child.exited).toBe(0);
  return names(modules);
}
/** Module paths as paths under src/ or package names. */
function names(modules: string[]): string[] {
  return [
    ...new Set(
      modules.map(
        (module) =>
          module.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1] ??
          module.slice(module.indexOf("/src/") + 1),
      ),
    ),
  ].sort();
}

/** The modules a fresh Bun process has loaded once `rig args` ran in it, named as `loaded` names them. The Rig root is
 * one nothing has made, or one holding only `hostConfig` as its config.yaml. */
async function ranRig(args: string[], hostConfig?: string): Promise<string[]> {
  const base = await mkdtemp(join(tmpdir(), "rig-entry-imports-"));
  try {
    if (hostConfig !== undefined) {
      await mkdir(join(base, ".rig"), { mode: 0o700 });
      await writeFile(join(base, ".rig", "config.yaml"), hostConfig);
    }
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { main } = await import(${JSON.stringify(source("index.ts"))});
         await main(${JSON.stringify(args)});
         process.stderr.write(JSON.stringify(Object.keys(require.cache)));`,
      ],
      {
        cwd: base,
        env: { ...process.env, RIG_ROOT: join(base, ".rig") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(0);
    expect(stdout).not.toBe("");
    return names(JSON.parse(stderr) as string[]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("a capture wrapper loads only capture code: rigd's daemon and its commands load once one of them is chosen", async () => {
  const wrapper = await loaded(source("rigd.ts"));
  const capture = await loaded(
    source("providers/captured-process.ts"),
    source("cli/entry-environment.ts"),
  );
  expect(wrapper).toEqual([...capture, "src/rigd.ts"].sort());
  expect(wrapper).not.toContain("commander");
  expect(wrapper).not.toContain("src/daemon/composition.ts");
  expect(wrapper).not.toContain("src/cli/rigd.ts");
});

test("rig loads no config reader, config schema, offline doctor or certificate check until a command needs one", async () => {
  const rig = await loaded(source("index.ts"));
  expect(rig).toContain("src/cli/commands.ts");
  for (const deferred of [
    "yaml",
    "src/config/documents.ts",
    "src/config/schema.ts",
    "src/daemon/offline-doctor.ts",
    "src/adapters/host-inspection.ts",
    "src/adapters/proxy-verify.ts",
    "src/adapters/proxy-token.ts",
  ])
    expect(rig).not.toContain(deferred);
});

/** What only running a command needs: the schema library and every schema, rigd's client, and the code that sends a
 * command, renders its answer and plans a DNS change. */
const EXECUTION = [
  "zod",
  "src/daemon/protocol.ts",
  "src/daemon/client.ts",
  "src/cli/execution.ts",
  "src/cli/output.ts",
  "src/cli/dns-plan.ts",
  "src/domain/dns-records.ts",
];

test("rig's help loads the command grammar alone: no schema, rigd client or command execution", async () => {
  for (const args of [
    [],
    ["--help"],
    ["status", "-h"],
    ["logs", "--help"],
    ["dns", "set", "-h"],
    ["help", "backup", "restore"],
  ]) {
    const help = await ranRig(args);
    expect(help).toContain("commander");
    expect(help).toContain("src/cli/commands.ts");
    expect({ args, loaded: EXECUTION.filter((m) => help.includes(m)) }).toEqual(
      {
        args,
        loaded: [],
      },
    );
  }
  // The same probe sees what a command loads once it runs, so the absences above are not its blind spot.
  const read = await ranRig(["status", "--json"]);
  for (const module of EXECUTION.filter((m) => !m.includes("dns")))
    expect(read).toContain(module);
}, 60_000);

/** What reading or editing whole config documents needs: the YAML parser, the Host and Project schemas, and the document
 * reader with its editor and JSON Schema. */
const CONFIG_DOCUMENTS = [
  "yaml",
  "src/config/yaml-document.ts",
  "src/config/host-schema.ts",
  "src/config/schema.ts",
  "src/config/project-fields.ts",
  "src/config/project-rules.ts",
  "src/config/target-patch.ts",
  "src/config/retired-keys.ts",
  "src/config/documents.ts",
  "src/config/editor.ts",
  "src/config/json-schema.ts",
];

test("a read and a usage error open the diagnostic log without the YAML parser, a config schema or the config editor while config.yaml cannot set diagnostics", async () => {
  for (const hostConfig of [undefined, "deploy:\n  production_branch: trunk\n"])
    for (const args of [
      ["list", "--json"],
      ["status", "--json"],
      ["list", "--json", "--bogus"],
    ]) {
      const run = await ranRig(args, hostConfig);
      expect({
        args,
        hostConfig,
        loaded: CONFIG_DOCUMENTS.filter((m) => run.includes(m)),
      }).toEqual({ args, hostConfig, loaded: [] });
      // Each opened its diagnostic log through Host config, so the absences above are not a log it never opened.
      expect(run).toContain("src/config/host-diagnostics.ts");
      expect(run).toContain("src/diagnostics/file-log.ts");
    }
  // A document that may set the section is parsed and checked as Host config, still without the Project schema or editor.
  const configured = await ranRig(
    ["list", "--json"],
    "diagnostics:\n  level: debug\n",
  );
  expect(CONFIG_DOCUMENTS.filter((m) => configured.includes(m))).toEqual([
    "yaml",
    "src/config/yaml-document.ts",
    "src/config/host-schema.ts",
  ]);
}, 60_000);
