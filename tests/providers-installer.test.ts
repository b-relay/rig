import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("install publishes an executable and preserves the last good artifact when a later build fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-"));
  roots.push(root);
  await writeFile(join(root, "entry"), "#!/bin/sh\necho ready\n");
  const installer = createArtifactInstaller({
    run: runCommand,
    bunExecutable: process.execPath,
  });
  const request = {
    cwd: root,
    entrypoint: "entry",
    destination: join(root, "bin", "tool"),
    env: { PATH: "/usr/bin:/bin" },
  };
  await installer.install(request);
  expect((await stat(request.destination)).mode & 0o111).toBe(0o111);
  expect(await installer.observe(request.destination)).toBe("installed");
  await writeFile(join(root, "entry"), "broken");
  await expect(
    installer.install({ ...request, build: "exit 9" }),
  ).rejects.toThrow();
  expect(await readFile(request.destination, "utf8")).toBe(
    "#!/bin/sh\necho ready\n",
  );
});
test("source entrypoints install a runnable Bun shim that retains relative imports and arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-source-"));
  roots.push(root);
  await writeFile(join(root, "value.ts"), "export const value='ready';");
  await writeFile(
    join(root, "main.ts"),
    "import {value} from './value';process.stdout.write(value+':'+process.argv[2]);",
  );
  const installer = createArtifactInstaller({
    run: runCommand,
    bunExecutable: process.execPath,
  });
  const installed = await installer.install({
    cwd: root,
    entrypoint: "main.ts",
    destination: join(root, "bin", "tool"),
    env: { PATH: process.env.PATH! },
  });
  const result = await runCommand({
    command: [installed.path, "test argument"],
    cwd: tmpdir(),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("ready:test argument");
});
test("the installer builds through the supplied runner and shims source entrypoints with the supplied bun, never the PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-explicit-"));
  roots.push(root);
  await writeFile(join(root, "main.ts"), "export {};");
  const bun = join(root, "private bun", "bin", "bun");
  await mkdir(dirname(bun), { recursive: true });
  await writeFile(bun, "#!/bin/sh\n", { mode: 0o755 });
  const commands: string[][] = [];
  const installer = createArtifactInstaller({
    async run(request) {
      commands.push([...request.command]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    bunExecutable: bun,
  });
  const installed = await installer.install({
    cwd: root,
    entrypoint: "main.ts",
    destination: join(root, "bin", "tool"),
    build: "echo building",
    env: { PATH: "" },
  });
  expect(commands).toEqual([["/bin/sh", "-c", "echo building"]]);
  expect(await readFile(installed.path, "utf8")).toBe(
    `#!/bin/sh\nexec '${bun}' '${join(root, "main.ts")}' "$@"\n`,
  );
});
test("a source entrypoint without a runnable bun fails as BUN_NOT_FOUND before building, and nothing is published", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-install-no-bun-"));
  roots.push(root);
  await writeFile(join(root, "main.ts"), "export {};");
  const destination = join(root, "bin", "tool");
  const commands: string[][] = [];
  const run = async (request: { command: readonly string[] }) => {
    commands.push([...request.command]);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const request = {
    cwd: root,
    entrypoint: "main.ts",
    destination,
    build: "echo building",
    env: { PATH: "" },
  };
  await expect(
    createArtifactInstaller({ run, bunExecutable: undefined }).install(request),
  ).rejects.toMatchObject({
    _tag: "RigError",
    code: "BUN_NOT_FOUND",
    message: expect.stringContaining(join(root, "main.ts")),
    hint: expect.stringContaining("rigd install"),
    details: { entrypoint: join(root, "main.ts") },
  });
  // A recorded bun that has since been removed is as unusable as none.
  const gone = join(root, "removed", "bun");
  await expect(
    createArtifactInstaller({ run, bunExecutable: gone }).install(request),
  ).rejects.toMatchObject({
    code: "BUN_NOT_FOUND",
    message: expect.stringContaining(gone),
    hint: expect.stringContaining("rigd install"),
    details: { entrypoint: join(root, "main.ts"), bun: gone },
  });
  expect(commands).toEqual([]);
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  // A built executable never needs bun.
  await writeFile(join(root, "built"), "#!/bin/sh\necho ready\n");
  const installed = await createArtifactInstaller({
    run,
    bunExecutable: undefined,
  }).install({ ...request, entrypoint: "built" });
  expect(await readFile(installed.path, "utf8")).toBe(
    "#!/bin/sh\necho ready\n",
  );
});
