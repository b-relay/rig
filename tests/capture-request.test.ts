import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCaptureRequest,
  writeCaptureRequest,
} from "../src/providers/capture-request";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const request = (marker: string) => ({
  key: "target/web",
  componentName: "web",
  command: ["/bin/sh", "-c", "serve"],
  cwd: "/srv/app",
  env: { MARKER: marker, PAD: "x".repeat(4 * 1024 * 1024) },
  logRoot: "/srv/logs",
  incarnation: "start-1",
});

test("a capture request is replaced whole: a reader never sees an empty or partial document", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-capture-request-"));
  roots.push(root);
  const requestPath = join(root, "job.json");
  await writeCaptureRequest(requestPath, request("first"));
  expect(await readCaptureRequest(requestPath)).toEqual(request("first"));
  const seen = new Set<string>();
  let done = false;
  const writing = writeCaptureRequest(requestPath, request("second")).then(
    () => {
      done = true;
    },
  );
  while (!done) {
    let raw: string | undefined;
    try {
      raw = readFileSync(requestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw !== undefined) seen.add(JSON.parse(raw).env.MARKER);
    await Bun.sleep(0);
  }
  await writing;
  expect(
    [...seen].every((marker) => marker === "first" || marker === "second"),
  ).toBe(true);
  expect(await readCaptureRequest(requestPath)).toEqual(request("second"));
  expect(await readdir(root)).toEqual(["job.json"]);
});

test("a request that is not a capture request is rejected by path", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-capture-request-"));
  roots.push(root);
  const requestPath = join(root, "job.json");
  await Bun.write(requestPath, JSON.stringify({ key: "" }));
  await expect(readCaptureRequest(requestPath)).rejects.toMatchObject({
    code: "CAPTURE_REQUEST",
    details: { path: requestPath },
  });
});
