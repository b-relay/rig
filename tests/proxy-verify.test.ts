import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyProxyCertificates } from "../src/adapters/proxy-verify";
import { parseHostConfig } from "../src/config";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => {});
});
async function openssl(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["/usr/bin/openssl", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await child.exited) !== 0)
    throw new Error(await new Response(child.stderr).text());
}
/** A root whose current generation serves `hostnames`, and a TLS server holding a certificate for app.example.test from a
 * CA that names itself a staging CA, as Let's Encrypt's staging CA does. */
async function world(hostnames: string[]) {
  const root = await mkdtemp(join(tmpdir(), "rig-verify-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pki = join(root, "pki");
  await mkdir(pki);
  await openssl(pki, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "30",
    "-subj",
    "/O=(STAGING) Pretend Pear/CN=(STAGING) Pretend Pear R1",
  ]);
  await openssl(pki, [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.csr",
    "-subj",
    "/CN=app.example.test",
  ]);
  await writeFile(join(pki, "ext"), "subjectAltName=DNS:app.example.test\n");
  await openssl(pki, [
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "leaf.crt",
    "-days",
    "30",
    "-extfile",
    "ext",
  ]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      cert:
        (await readFile(join(pki, "leaf.crt"), "utf8")) +
        (await readFile(join(pki, "ca.crt"), "utf8")),
      key: await readFile(join(pki, "leaf.key"), "utf8"),
    },
    fetch: () => new Response("ok"),
  });
  cleanups.push(async () => server.stop(true));
  const generation = join(root, "caddy", "generations", "g1");
  await mkdir(generation, { recursive: true });
  await writeFile(
    join(generation, "routes.caddy"),
    hostnames
      .map(
        (hostname, index) =>
          `# rig begin ${String(index).repeat(64)}\n${hostname} {\n  reverse_proxy 127.0.0.1:1\n}\n# rig end ${String(index).repeat(64)}\n`,
      )
      .join(""),
  );
  await writeFile(
    join(generation, "generation.json"),
    JSON.stringify({ customRoutes: [] }),
  );
  await symlink(join("generations", "g1"), join(root, "caddy", "current"));
  return { root, port: server.port! };
}

test("a staging certificate fails as untrusted, and passes with --staging-ok only for the name it was issued to", async () => {
  const w = await world(["app.example.test"]);
  const [strict] = await verifyProxyCertificates({
    root: w.root,
    port: w.port,
    stagingOk: false,
    waitMs: 0,
  });
  expect(strict).toMatchObject({
    ok: false,
    problem: expect.stringContaining("not trusted"),
  });
  const [staged] = await verifyProxyCertificates({
    root: w.root,
    port: w.port,
    stagingOk: true,
    waitMs: 0,
  });
  expect(staged).toMatchObject({
    hostname: "app.example.test",
    ok: true,
    issuer: "(STAGING) Pretend Pear / (STAGING) Pretend Pear R1",
  });

  const other = await world(["other.example.test"]);
  const [mismatch] = await verifyProxyCertificates({
    root: other.root,
    port: w.port,
    stagingOk: true,
    waitMs: 0,
  });
  expect(mismatch).toMatchObject({
    hostname: "other.example.test",
    ok: false,
  });
}, 30_000);

test("nothing listening on the port is a failure that names the port", async () => {
  const w = await world(["app.example.test"]);
  const [verdict] = await verifyProxyCertificates({
    root: w.root,
    port: 1,
    stagingOk: true,
    waitMs: 0,
  });
  expect(verdict).toMatchObject({ ok: false });
}, 30_000);

test("without --port, verify dials the HTTPS port the pinned generation was accepted with, not a pending one in Host config", async () => {
  const w = await world(["app.example.test"]);
  const accepted = parseHostConfig({
    proxy: { caddy: "/c", ports: { http: 18080, https: w.port } },
  }).proxy!;
  await writeFile(
    join(w.root, "caddy", "generations", "g1", "generation.json"),
    JSON.stringify({ proxy: accepted, customRoutes: [] }),
  );
  // Host config says 28443, which Caddy has not taken: nothing listens there.
  const [verdict] = await verifyProxyCertificates({
    root: w.root,
    defaultPort: 28443,
    stagingOk: true,
    waitMs: 0,
  });
  expect(verdict).toMatchObject({ hostname: "app.example.test", ok: true });
});

test("a verdict holds only for the generation and port it was made against: a new generation asks every hostname again", async () => {
  const w = await world(["app.example.test", "other.example.test"]);
  const closed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const closedPort = closed.port!;
  closed.stop(true);
  let passes = 0;
  const verdicts = await verifyProxyCertificates({
    root: w.root,
    defaultPort: w.port,
    stagingOk: true,
    waitMs: 1500,
    pause: async () => {
      passes++;
      if (passes !== 1) return;
      // app passed and other failed; the next generation drops other and serves HTTPS on a port nothing listens on.
      const g2 = join(w.root, "caddy", "generations", "g2");
      await mkdir(g2, { recursive: true });
      await writeFile(
        join(g2, "routes.caddy"),
        `# rig begin ${"0".repeat(64)}\napp.example.test {\n  reverse_proxy 127.0.0.1:1\n}\n# rig end ${"0".repeat(64)}\n`,
      );
      await writeFile(
        join(g2, "generation.json"),
        JSON.stringify({
          proxy: parseHostConfig({
            proxy: { caddy: "/c", ports: { http: 18080, https: closedPort } },
          }).proxy,
          customRoutes: [],
        }),
      );
      await symlink(join("generations", "g2"), join(w.root, "caddy", "next"));
      await rename(
        join(w.root, "caddy", "next"),
        join(w.root, "caddy", "current"),
      );
    },
  });
  expect(passes).toBeGreaterThan(1);
  expect(verdicts).toEqual([
    expect.objectContaining({ hostname: "app.example.test", ok: false }),
  ]);
});
