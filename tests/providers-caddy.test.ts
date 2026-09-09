import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaddyRouter } from "../src/providers/caddy-router";
import { createHash } from "node:crypto";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("route checkpoints preserve CRLF and incomplete markers fail before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-markers-"));
  roots.push(root);
  const caddyfile = join(root, "Caddyfile");
  const router = createCaddyRouter({
    caddyfile,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    reload: false,
  });
  const token = createHash("sha256").update("target").digest("hex");
  const begin = `# rig begin ${token}`;
  const end = `# rig end ${token}`;
  const block = `${begin}\r\napp.test {\r\n reverse_proxy localhost:3000\r\n}\r\n${end}\r\n`;
  const unrelated = "# retain this\r\n";
  await writeFile(caddyfile, block + unrelated);
  expect(await router.checkpoint("target")).toEqual({
    key: "target",
    value: block,
  });
  await router.remove("target");
  expect(await readFile(caddyfile, "utf8")).toBe(unrelated);
  for (const malformed of [begin, end, `${end}\n${begin}`]) {
    await writeFile(caddyfile, malformed);
    await expect(router.checkpoint("target")).rejects.toMatchObject({
      code: "ROUTE_CORRUPT",
    });
    await expect(router.remove("target")).rejects.toMatchObject({
      code: "ROUTE_CORRUPT",
    });
    await expect(
      router.restore({ key: "target", value: null }, { key: "other", value: null }),
    ).rejects.toMatchObject({ code: "ROUTE_CHANGED" });
    expect(await readFile(caddyfile, "utf8")).toBe(malformed);
  }
});
test("route changes preserve unrelated text and rollback the file if reload fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-"));
  roots.push(root);
  const file = join(root, "Caddyfile");
  const unrelated =
    "# user-owned\nother.example.test {\n reverse_proxy 127.0.0.1:8080\n}\n";
  await writeFile(file, unrelated);
  let failReload = false;
  const router = createCaddyRouter({
    caddyfile: file,
    run: async ({ command }) => ({
      exitCode: command[1] === "reload" && failReload ? 1 : 0,
      stdout: "",
      stderr: "test rejection",
    }),
  });
  await router.apply({
    key: "target/web",
    hostname: "app.example.test",
    upstream: "127.0.0.1:3000",
  });
  const deployed = await readFile(file, "utf8");
  expect(deployed.startsWith(unrelated)).toBe(true);
  expect(deployed).toContain("reverse_proxy 127.0.0.1:3000");
  failReload = true;
  await expect(
    router.apply({
      key: "target/web",
      hostname: "app.example.test",
      upstream: "127.0.0.1:3001",
    }),
  ).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(deployed);
  failReload = false;
  await router.remove("target/web");
  expect((await readFile(file, "utf8")).trim()).toBe(unrelated.trim());
  await expect(
    router.apply({
      key: "other",
      hostname: "other.example.test",
      upstream: "127.0.0.1:3002",
    }),
  ).rejects.toThrow("owned");
});
test("real Caddy applies and removes an isolated route without affecting another site", async () => {
  const { existsSync } = await import("node:fs");
  const { runCommand } = await import("../src/providers/command-runner");
  const executable = ["/usr/local/bin/caddy", "/opt/homebrew/bin/caddy"].find(
    existsSync,
  );
  if (!executable)
    throw new Error(
      "Real Caddy integration requires a local caddy executable.",
    );
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-live-"));
  roots.push(root);
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("managed app"),
  });
  const reserve = () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(""),
    });
    const port = server.port!;
    server.stop(true);
    return port;
  };
  const admin = reserve(),
    site = reserve(),
    other = reserve();
  const file = join(root, "Caddyfile");
  await writeFile(
    file,
    `{\n admin 127.0.0.1:${admin}\n auto_https off\n}\nhttp://127.0.0.1:${other} {\n respond "other app"\n}\n`,
  );
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: root,
    XDG_DATA_HOME: root,
  } as Record<string, string>;
  const child = Bun.spawn(
    [executable, "run", "--config", file, "--adapter", "caddyfile"],
    { env, stdout: "ignore", stderr: "ignore" },
  );
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${admin}/config/`)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(30);
    }
    expect(ready).toBe(true);
    const router = createCaddyRouter({
      caddyfile: file,
      executable,
      run: (request) =>
        runCommand({
          ...request,
          env,
          command:
            request.command[1] === "reload"
              ? [...request.command, "--address", `127.0.0.1:${admin}`]
              : request.command,
        }),
    });
    await router.apply({
      key: "real-route",
      hostname: `http://127.0.0.1:${site}`,
      upstream: `127.0.0.1:${upstream.port}`,
    });
    expect(await (await fetch(`http://127.0.0.1:${site}`)).text()).toBe(
      "managed app",
    );
    expect(await (await fetch(`http://127.0.0.1:${other}`)).text()).toBe(
      "other app",
    );
    await router.remove("real-route");
    expect(await (await fetch(`http://127.0.0.1:${other}`)).text()).toBe(
      "other app",
    );
    await expect(fetch(`http://127.0.0.1:${site}`)).rejects.toThrow();
  } finally {
    child.kill();
    await child.exited;
    upstream.stop(true);
  }
}, 15000);
test("host route directives and the configured reload command are preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-host-"));
  roots.push(root);
  const caddyfile = join(root, "Caddyfile");
  const commands: string[][] = [];
  const router = createCaddyRouter({
    caddyfile,
    extraConfig: ["encode gzip", "header X-Rig managed"],
    reloadCommand: ["/bin/sh", "-c", "custom-reload"],
    run: async (request) => {
      commands.push([...request.command]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await router.apply({
    key: "host",
    hostname: "app.example.test",
    upstream: "localhost:3000",
  });
  expect(await readFile(caddyfile, "utf8")).toContain(
    "  encode gzip\n  header X-Rig managed\n",
  );
  expect(commands[1]).toEqual(["/bin/sh", "-c", "custom-reload"]);
});
test("a route checkpoint restores its exact owned block and refuses to overwrite a later edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-checkpoint-"));
  roots.push(root);
  const file = join(root, "Caddyfile"),
    router = createCaddyRouter({
      caddyfile: file,
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
  const absent = await router.checkpoint("target");
  await router.apply({
    key: "target",
    hostname: "old.test",
    upstream: "localhost:3000",
  });
  const previous = await router.checkpoint("target");
  await router.apply({
    key: "target",
    hostname: "new.test",
    upstream: "localhost:4000",
  });
  const candidate = await router.checkpoint("target");
  await router.apply({
    key: "other",
    hostname: "unrelated.test",
    upstream: "localhost:5000",
  });
  await router.restore(previous, candidate);
  expect(await router.checkpoint("target")).toEqual(previous);
  expect(await readFile(file, "utf8")).toContain("unrelated.test");
  await expect(router.restore(absent, candidate)).rejects.toMatchObject({
    code: "ROUTE_CHANGED",
  });
  expect(await router.checkpoint("target")).toEqual(previous);
  await router.restore(absent, previous);
  expect(await router.checkpoint("target")).toEqual(absent);
});
