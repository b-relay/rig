import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { legacyRoot } from "./support/legacy-root";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}, 60_000);
async function legacy(options?: Parameters<typeof legacyRoot>[0]) {
  const fixture = await legacyRoot(options);
  cleanups.push(fixture.cleanup);
  return fixture;
}
/** Every file under `directory` with a digest of its bytes: what a read-only step must leave identical. */
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files[relative(directory, path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  };
  await walk(directory);
  return files;
}
const json = (text: string) => JSON.parse(text);
const body = async (port: number) =>
  await (await fetch(`http://127.0.0.1:${port}/`)).text();

test("a reviewed conversion is previewed without writes, applied, activated by the new runtime and rolled back with data intact", async () => {
  const root = await legacy(),
    review = join(root.base, "review.yaml"),
    original = await readFile(root.statePath, "utf8"),
    sentinels = await Promise.all(
      root.sentinels.map((path) => readFile(path, "utf8")),
    );
  await writeFile(review, "hooks:\n  demo/web/preStart: { as: build }\n");

  // The new runtime reads nothing from an unconverted root.
  expect((await root.rigd(["install"])).code).toBe(0);
  const refused = await root.rig(["list"]);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain("cutover");

  // Preview is read-only, and names the running daemon as the reason nothing can be applied yet.
  const busy = await root.cutover(["preview", "--review", review]);
  expect(busy.code).toBe(0);
  expect(
    json(busy.stdout).blockers.map((b: { code: string }) => b.code),
  ).toEqual(["daemon_running"]);
  expect(await readFile(root.statePath, "utf8")).toBe(original);
  expect((await root.rigd(["uninstall"])).code).toBe(0);

  const stopped = await snapshot(root.base);
  const previewed = await root.cutover(["preview", "--review", review]);
  expect(previewed.stderr).toBe("");
  const preview = json(previewed.stdout);
  expect(preview.blockers).toEqual([]);
  expect(await snapshot(root.base)).toEqual(stopped);
  const live = preview.targets.find(
    (target: { project: string; name: string }) =>
      target.project === "demo" && target.name === "live",
  );
  expect(live.builds).toEqual([
    { id: "service:web", from: "hooks.preStart", timeout: 30 },
    { id: "tool:demo-tool", from: "build", timeout: 90 },
  ]);
  expect(live.start).toBe("needs-deploy");
  expect(previewed.stdout).not.toContain("file-secret");

  const applied = await root.cutover([
    "apply",
    "--review",
    review,
    "--revision",
    preview.revision,
  ]);
  expect(applied.stderr).toBe("");
  expect(applied.code).toBe(0);
  const outcome = json(applied.stdout);
  for (const [index, path] of root.sentinels.entries())
    expect(await readFile(path, "utf8")).toBe(sentinels[index]!);
  expect(
    await readFile(join(outcome.backupPath, "runtime/state.json"), "utf8"),
  ).toBe(original);

  // The new runtime inspects the converted root and starts the saved Deployment from its saved policy.
  expect((await root.rigd(["install"])).code).toBe(0);
  const status = await root.rig(["status", "--project", "plain"]);
  expect(status.stdout).toContain(root.plainCommit.slice(0, 7));
  expect(status.stdout).toContain("stopped");
  const up = await root.rig(["up", "live", "--project", "plain"], root.base);
  expect(up.stderr).toBe("");
  expect(await body(47421)).toBe("plain  from-lane");
  // Deploying again needs a Commit in the new format; the old one is refused, not read through a compatibility layer.
  const retired = await root.rig(
    ["deploy", "live", "--project", "plain"],
    root.base,
  );
  expect(retired.code).not.toBe(0);
  expect(retired.stderr).toContain("retired configuration");
  expect(await body(47421)).toBe("plain  from-lane");
  // A hook mapped to a build was never run as one, so no build success exists and the saved Deployment does not start.
  const unprepared = await root.rig(
    ["up", "live", "--project", "demo"],
    root.base,
  );
  expect(unprepared.code).not.toBe(0);
  expect(unprepared.stderr).toContain("cannot start as it was saved");
  // What it asks for: the reviewed candidate committed without the secret file, whose values move to the Host role file.
  await writeFile(
    join(root.demoRepo, "rig.yaml"),
    await readFile(join(outcome.reportPath, "demo.rig.yaml"), "utf8"),
  );
  await root.git(["rm", "-q", "rig.json", "app.env"]);
  await root.commit();
  await mkdir(join(root.root, "env/demo/web"), { recursive: true });
  await writeFile(
    join(root.root, "env/demo/web/all.env"),
    "FROM_FILE=file-secret\n",
    { mode: 0o600 },
  );
  const deployed = await root.rig(["deploy", "live"]);
  expect(deployed.code).toBe(0);
  expect(await body(47412)).toBe("hello file-secret ");
  expect((await root.rig(["down", "live"])).code).toBe(0);
  expect(
    (await root.rig(["down", "live", "--project", "plain"], root.base)).code,
  ).toBe(0);

  // Rollback after the new runtime is stopped: the old state comes back byte for byte, data untouched, intent stopped.
  expect((await root.rigd(["uninstall"])).code).toBe(0);
  const rolledBack = await root.cutover([
    "rollback",
    "--backup",
    outcome.backupPath,
  ]);
  expect(rolledBack.stderr).toBe("");
  expect(await readFile(root.statePath, "utf8")).toBe(original);
  for (const [index, path] of root.sentinels.entries())
    expect(await readFile(path, "utf8")).toBe(sentinels[index]!);

  // The rolled-back root is convertible again; the repository the operator changed is now read as current.
  const again = json(
    (await root.cutover(["preview", "--review", review])).stdout,
  );
  expect(again.status).toBe("legacy");
  expect(again.blockers).toEqual([]);
  expect(
    again.projects.map((project: { config: string }) => project.config),
  ).toEqual(["current", "legacy"]);
}, 180_000);

test("an unmapped hook blocks the conversion: nothing is written and the new runtime activates nothing", async () => {
  const root = await legacy(),
    review = join(root.base, "review.yaml");
  await writeFile(review, "hooks: {}\n");
  const before = await snapshot(root.base);
  const preview = json(
    (await root.cutover(["preview", "--review", review])).stdout,
  );
  expect(preview.blockers).toContainEqual({
    code: "unmapped_hook",
    project: "demo",
    target: "live",
    subject: "demo/web/preStart",
    message: expect.stringContaining("demo/web/preStart"),
  });
  const applied = await root.cutover([
    "apply",
    "--review",
    review,
    "--revision",
    preview.revision,
  ]);
  expect(applied.code).toBe(1);
  expect(applied.stderr).toContain("CONVERSION_BLOCKED");
  expect(applied.stderr).toContain("demo/web/preStart");
  expect(await snapshot(root.base)).toEqual(before);

  expect((await root.rigd(["install"])).code).toBe(0);
  const up = await root.rig(["up", "live", "--project", "plain"], root.base);
  expect(up.code).not.toBe(0);
  await rm(review);
}, 60_000);
