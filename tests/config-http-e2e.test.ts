import { expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { rigFixture } from "./support/rig-fixture";

const sourceSchema = z.object({
  result: z.object({
    project: z.string(),
    revision: z.string(),
    raw: z.string(),
    fields: z.array(z.object({ path: z.string() })),
  }),
});
const previewSchema = z.object({
  result: z.object({
    baseRevision: z.string(),
    nextRevision: z.string(),
    raw: z.string(),
  }),
});
const appliedSchema = z.object({
  result: z.object({
    applied: z.literal(true),
    baseRevision: z.string(),
    nextRevision: z.string(),
    raw: z.string(),
    backupPath: z.string(),
  }),
});

/** Test transport owner: each request rereads installation credentials so daemon restarts are exercised. */
function configHttp(root: string) {
  return async (
    input: unknown,
    access: { token?: "wrong" | "absent"; origin?: string } = {},
  ) => {
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
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (access.token !== "absent")
      headers.authorization = `Bearer ${access.token === "wrong" ? "wrong-token" : token}`;
    if (access.origin) headers.origin = access.origin;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/config`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
}

const original =
  "# Project commentary\nname: demo\ndescription: original\ncomponents:\n  web:\n    mode: managed\n    command: serve # preserve command note\n";

test("real authenticated config HTTP preview/apply preserves comments, exact backup, revision and restart persistence", async () => {
  const f = await rigFixture(),
    path = join(f.repo, "rig.yaml"),
    http = configHttp(f.root);
  try {
    await writeFile(path, original);
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    const read = await http({ action: "read", project: "demo" });
    expect(read.status).toBe(200);
    const source = sourceSchema.parse(read.body).result;
    expect(source.raw).toBe(original);
    expect(
      source.fields.some((field) => field.path === "components.*.command"),
    ).toBe(true);
    const request = {
      project: "demo",
      expectedRevision: source.revision,
      patch: [
        {
          op: "set",
          path: ["components", "web", "command"],
          value: "serve --port 3000",
        },
      ],
    };
    const filesBefore = (await readdir(f.repo)).sort();
    const previewResponse = await http({ action: "preview", ...request });
    expect(previewResponse.status).toBe(200);
    const preview = previewSchema.parse(previewResponse.body).result;
    expect(preview.raw).toContain("serve --port 3000 # preserve command note");
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await readdir(f.repo)).sort()).toEqual(filesBefore);
    const applyResponse = await http({ action: "apply", ...request });
    expect(applyResponse.status).toBe(200);
    const applied = appliedSchema.parse(applyResponse.body).result;
    expect(applied.nextRevision).toBe(preview.nextRevision);
    expect(applied.baseRevision).toBe(source.revision);
    expect(await readFile(path, "utf8")).toBe(preview.raw);
    expect(await readFile(applied.backupPath, "utf8")).toBe(original);
    const stale = await http({ action: "apply", ...request });
    expect(stale).toMatchObject({
      status: 422,
      body: { error: { code: "REVISION_CONFLICT" } },
    });
    expect(await readFile(path, "utf8")).toBe(preview.raw);
    expect(await f.rigd(["uninstall"])).toMatchObject({ code: 0 });
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    const restarted = sourceSchema.parse(
      (await http({ action: "read", project: "demo" })).body,
    ).result;
    expect(restarted.revision).toBe(applied.nextRevision);
    expect(restarted.raw).toBe(preview.raw);
    expect(await readFile(applied.backupPath, "utf8")).toBe(original);
  } finally {
    await f.cleanup();
  }
}, 20000);

test("real config HTTP rejects unauthorized, cross-origin, identity and unknown-field writes without modifying config", async () => {
  const f = await rigFixture(),
    path = join(f.repo, "rig.yaml"),
    http = configHttp(f.root);
  try {
    await writeFile(path, original);
    expect(await f.rigd(["install"])).toMatchObject({ code: 0 });
    expect(await f.rig(["init", "--create-git"])).toMatchObject({ code: 0 });
    const source = sourceSchema.parse(
      (await http({ action: "read", project: "demo" })).body,
    ).result;
    const request = {
      action: "apply",
      project: "demo",
      expectedRevision: source.revision,
      patch: [{ op: "set", path: ["description"], value: "unauthorized" }],
    };
    const filesBefore = (await readdir(f.repo)).sort();
    for (const token of ["absent", "wrong"] as const)
      expect(await http(request, { token })).toMatchObject({
        status: 401,
        body: { error: { code: "UNAUTHORIZED" } },
      });
    expect(
      await http(request, { origin: "https://foreign.example" }),
    ).toMatchObject({ status: 403, body: { error: { code: "ORIGIN" } } });
    for (const [editPath, code] of [
      [["name"], "IDENTITY_CHANGE"],
      [["components", "web", "unknown"], "INVALID_EDIT"],
    ] as const) {
      expect(
        await http({
          ...request,
          patch: [{ op: "set", path: editPath, value: "invalid" }],
        }),
      ).toMatchObject({ status: 422, body: { error: { code } } });
    }
    expect(
      await http({ ...request, configPath: "/tmp/unowned.yaml" }),
    ).toMatchObject({ status: 422, body: { error: { code: "INVALID_EDIT" } } });
    expect(await http({ action: "read", project: "unknown" })).toMatchObject({
      status: 422,
      body: { error: { code: "PROJECT_MISSING" } },
    });
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await readdir(f.repo)).sort()).toEqual(filesBefore);
  } finally {
    await f.cleanup();
  }
}, 20000);
