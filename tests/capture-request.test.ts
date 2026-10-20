import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
/** Where rigd writes a request: in the capture directory of the Rig root `root`. */
async function captureFile(root: string): Promise<string> {
  await mkdir(join(root, "capture"), { mode: 0o700 });
  return join(root, "capture", "job.json");
}
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
  const requestPath = await captureFile(root);
  await writeCaptureRequest(root, requestPath, request("first"));
  expect(await readCaptureRequest(root, requestPath)).toEqual(request("first"));
  const seen = new Set<string>();
  let done = false;
  const writing = writeCaptureRequest(
    root,
    requestPath,
    request("second"),
  ).then(() => {
    done = true;
  });
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
  expect(await readCaptureRequest(root, requestPath)).toEqual(
    request("second"),
  );
  expect(await readdir(join(root, "capture"))).toEqual(["job.json"]);
});

test("a request that is not a capture request is rejected by path", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-capture-request-"));
  roots.push(root);
  const requestPath = await captureFile(root);
  await Bun.write(requestPath, JSON.stringify({ key: "" }));
  await expect(readCaptureRequest(root, requestPath)).rejects.toMatchObject({
    code: "CAPTURE_REQUEST",
    details: { path: requestPath },
  });
});

test("a capture request names the Rig root whose logs settings its wrapper rotates by; one an older rigd wrote has none", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-capture-request-"));
  roots.push(root);
  const requestPath = await captureFile(root);
  await writeCaptureRequest(
    root,
    requestPath,
    request("kept"),
    "/isolated/.rig",
  );
  expect(await readCaptureRequest(root, requestPath)).toEqual({
    ...request("kept"),
    configRoot: "/isolated/.rig",
  });
  await writeCaptureRequest(root, requestPath, request("older"));
  expect(await readCaptureRequest(root, requestPath)).not.toHaveProperty(
    "configRoot",
  );
});
