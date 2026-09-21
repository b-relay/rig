import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const commands: string[][] = [];
  const installer = createArtifactInstaller({
    async run(request) {
      commands.push([...request.command]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    bunExecutable: "/opt/private bun/bin/bun",
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
    `#!/bin/sh\nexec '/opt/private bun/bin/bun' '${join(root, "main.ts")}' "$@"\n`,
  );
});
