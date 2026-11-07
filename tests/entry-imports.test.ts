import { expect, test } from "bun:test";
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
