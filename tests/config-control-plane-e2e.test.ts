import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { rigFixture } from "./support/rig-fixture";

const example = (name: string) =>
  join(import.meta.dir, "..", "docs", "examples", `${name}.rig.yaml`);
const result = <T extends z.ZodType>(schema: T) => z.object({ result: schema });
const sourceSchema = result(
  z.object({
    revision: z.string(),
    raw: z.string(),
    config: z.record(z.string(), z.unknown()),
  }),
);
const changeSchema = result(
  z.object({ nextRevision: z.string(), raw: z.string() }),
);
const appliedSchema = result(
  z.object({ applied: z.literal(true), backupPath: z.string() }),
);

/** Each request rereads installation credentials, like any other control-plane client. */
function configHttp(root: string) {
  return async (input: unknown) => {
    const address = z
      .object({ port: z.number() })
      .parse(
        JSON.parse(
          await readFile(join(root, "daemon", "address.json"), "utf8"),
        ),
      );
    const token = (
      await readFile(join(root, "auth", "control-plane.token"), "utf8")
    ).trim();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
}

test("the single-Service example initializes with working/stable role keys, then reads, previews, applies and rejects a stale Target name and settings edit", async () => {
  const f = await rigFixture(),
    path = join(f.repo, "rig.yaml"),
    http = configHttp(f.root);
  try {
    await copyFile(example("service"), path);
    const original = await readFile(path, "utf8");
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    const read = await http({ action: "read", project: "notes" });
    expect(read.status).toBe(200);
    const source = sourceSchema.parse(read.body).result;
    expect(source.raw).toBe(original);
    expect(source.config).toMatchObject({
      name: "notes",
      targets: { working: { name: "local" }, stable: { name: "live" } },
    });
    const request = {
      project: "notes",
      expectedRevision: source.revision,
      patch: [
        { op: "set", path: ["targets", "working", "name"], value: "dev" },
        {
          op: "set",
          path: ["targets", "working", "services", "api", "env", "LOG_LEVEL"],
          value: "trace",
        },
      ],
    };
    const filesBefore = (await readdir(f.repo)).sort();
    const previewed = await http({ action: "preview", ...request });
    expect(previewed.status).toBe(200);
    const preview = changeSchema.parse(previewed.body).result;
    // The YAML editor keeps comments, order and scalars; it pads the braces of inline maps it re-emits.
    expect(preview.raw).toBe(
      original
        .replace("name: local", "name: dev")
        .replace("LOG_LEVEL: debug", "LOG_LEVEL: trace")
        .replace(/(?<!\$)\{(\w[^{}]*)\}/g, "{ $1 }"),
    );
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await readdir(f.repo)).sort()).toEqual(filesBefore);
    const applied = appliedSchema.parse(
      (await http({ action: "apply", ...request })).body,
    ).result;
    expect(await readFile(path, "utf8")).toBe(preview.raw);
    expect(await readFile(applied.backupPath, "utf8")).toBe(original);
    expect(await http({ action: "apply", ...request })).toMatchObject({
      status: 422,
      body: { error: { code: "REVISION_CONFLICT" } },
    });
    expect(await readFile(path, "utf8")).toBe(preview.raw);
    expect(await readFile(applied.backupPath, "utf8")).toBe(original);
  } finally {
    await f.cleanup();
  }
}, 20000);
