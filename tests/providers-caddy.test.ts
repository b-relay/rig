import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaddyRouter } from "../src/providers/caddy-router";
import { RigError } from "../src/domain/errors";
import { readdir, realpath } from "node:fs/promises";
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
      router.restore(
        { key: "target", value: null },
        { key: "other", value: null },
      ),
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
    routes: [{ prefix: "/", upstream: "127.0.0.1:3000" }],
  });
  const deployed = await readFile(file, "utf8");
  expect(deployed.startsWith(unrelated)).toBe(true);
  expect(deployed).toContain("reverse_proxy 127.0.0.1:3000");
  failReload = true;
  await expect(
    router.apply({
      key: "target/web",
      hostname: "app.example.test",
      routes: [{ prefix: "/", upstream: "127.0.0.1:3001" }],
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
      routes: [{ prefix: "/", upstream: "127.0.0.1:3002" }],
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
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => new Response(`api ${new URL(request.url).pathname}`),
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
      routes: [{ prefix: "/", upstream: `127.0.0.1:${upstream.port}` }],
    });
    expect(await (await fetch(`http://127.0.0.1:${site}`)).text()).toBe(
      "managed app",
    );
    expect(await (await fetch(`http://127.0.0.1:${other}`)).text()).toBe(
      "other app",
    );
    // A route map: a prefix matches at a slash boundary only, the longest first, and the upstream sees the path unchanged.
    const routes = (apiUpstream: string | null) => [
      { prefix: "/api", upstream: apiUpstream },
      { prefix: "/", upstream: `127.0.0.1:${upstream.port}` },
    ];
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${site}${path}`);
      return `${response.status} ${await response.text()}`;
    };
    await router.apply({
      key: "real-route",
      hostname: `http://127.0.0.1:${site}`,
      routes: routes(`127.0.0.1:${api.port}`),
    });
    expect(await get("/api/users")).toBe("200 api /api/users");
    expect(await get("/api")).toBe("200 api /api");
    expect(await get("/apix")).toBe("200 managed app");
    // A withheld path reaches no process; its sibling and the other site are untouched.
    await router.apply({
      key: "real-route",
      hostname: `http://127.0.0.1:${site}`,
      routes: routes(null),
    });
    expect(await get("/api/users")).toBe("503 ");
    expect(await get("/")).toBe("200 managed app");
    await router.remove("real-route");
    expect(await (await fetch(`http://127.0.0.1:${other}`)).text()).toBe(
      "other app",
    );
    await expect(fetch(`http://127.0.0.1:${site}`)).rejects.toThrow();
  } finally {
    child.kill();
    await child.exited;
    upstream.stop(true);
    api.stop(true);
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
    routes: [{ prefix: "/", upstream: "localhost:3000" }],
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
    routes: [{ prefix: "/", upstream: "localhost:3000" }],
  });
  const previous = await router.checkpoint("target");
  await router.apply({
    key: "target",
    hostname: "new.test",
    routes: [{ prefix: "/", upstream: "localhost:4000" }],
  });
  const candidate = await router.checkpoint("target");
  await router.apply({
    key: "other",
    hostname: "unrelated.test",
    routes: [{ prefix: "/", upstream: "localhost:5000" }],
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

test("a symlinked Caddyfile is updated through the link, so the file Caddy reads changes and the link survives", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-symlink-"));
  roots.push(root);
  const real = join(root, "etc", "Caddyfile"),
    link = join(root, "Caddyfile");
  await mkdir(join(root, "etc"));
  await writeFile(real, "# original\n");
  await symlink(real, link);
  const router = createCaddyRouter({
    caddyfile: link,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    reload: false,
  });
  await router.apply({
    key: "t1",
    hostname: "demo.localhost",
    routes: [{ prefix: "/", upstream: "127.0.0.1:3000" }],
  });
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readFile(real, "utf8")).toContain("demo.localhost");
  expect(await readFile(`${real}.rig-backup`, "utf8")).toBe("# original\n");
  await router.remove("t1");
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readFile(real, "utf8")).toBe("# original\n");
});

test("validation and reload failures carry Caddy's last stderr line, the rejected file is kept, and a missing caddy is named", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-evidence-"));
  roots.push(root);
  const file = join(root, "Caddyfile");
  const unrelated = "# user-owned\n";
  await writeFile(file, unrelated);
  const rejected = `${await realpath(file)}.rejected`;
  let mode: "reject" | "reload-fails" | "missing" = "reject";
  const router = createCaddyRouter({
    caddyfile: file,
    run: async ({ command }) => {
      if (mode === "missing")
        throw new RigError(
          "COMMAND_START",
          "Provider command 'caddy' could not start (spawn caddy ENOENT).",
          "Check the executable.",
          { executable: "caddy", cause: "spawn caddy ENOENT" },
        );
      if (command[1] === "validate" && mode === "reject")
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "2026/09/14 10:00:00 adapting config\nError: adapting config using caddyfile: port 99999 is out of range\n\n",
        };
      if (command[1] === "reload" && mode === "reload-fails")
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "Error: sending configuration to instance: connection refused\n",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const route = {
    key: "target/web",
    hostname: "app.example.test:99999",
    routes: [{ prefix: "/", upstream: "127.0.0.1:3000" }],
  };
  await expect(router.apply(route)).rejects.toMatchObject({
    code: "ROUTE_VALIDATE",
    message:
      "Caddy rejected the updated routes: Error: adapting config using caddyfile: port 99999 is out of range",
    hint: `The rejected configuration is kept at ${rejected}; fix the route configuration and retry.`,
    details: {
      rejectedPath: rejected,
      evidence:
        "Error: adapting config using caddyfile: port 99999 is out of range",
    },
  });
  expect(await readFile(file, "utf8")).toBe(unrelated);
  expect(await readFile(rejected, "utf8")).toContain("app.example.test:99999");
  expect((await readdir(root)).sort()).toEqual([
    "Caddyfile",
    "Caddyfile.rejected",
  ]);
  mode = "reload-fails";
  await expect(router.apply(route)).rejects.toMatchObject({
    code: "ROUTE_RELOAD",
    message:
      "Caddy could not reload (Error: sending configuration to instance: connection refused); the previous configuration was restored.",
    details: {
      evidence: "Error: sending configuration to instance: connection refused",
    },
  });
  expect(await readFile(file, "utf8")).toBe(unrelated);
  mode = "missing";
  await expect(router.apply(route)).rejects.toMatchObject({
    code: "CADDY_UNAVAILABLE",
    message: "Caddy could not start (spawn caddy ENOENT).",
    hint: "Install Caddy and make it available on the PATH rigd inherits, then run rig doctor.",
  });
  expect(await readFile(file, "utf8")).toBe(unrelated);
});

test("the conflict check compares site addresses the way Caddy does: an explicit :443 is the same site, another port is not", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-"));
  roots.push(root);
  const file = join(root, "Caddyfile");
  await writeFile(
    file,
    "app.example.test:443 {\n reverse_proxy 127.0.0.1:8080\n}\nHTTPS://Other.Example.Test {\n respond ok\n}\nthird.example.test:8443 {\n respond ok\n}\n",
  );
  const router = createCaddyRouter({
    caddyfile: file,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  for (const hostname of ["app.example.test", "other.example.test:443"])
    await expect(
      router.apply({
        key: `t/${hostname}`,
        hostname,
        routes: [{ prefix: "/", upstream: "127.0.0.1:3000" }],
      }),
    ).rejects.toMatchObject({ code: "ROUTE_CONFLICT" });
  await router.apply({
    key: "t/third",
    hostname: "third.example.test",
    routes: [{ prefix: "/", upstream: "127.0.0.1:3000" }],
  });
  expect(await readFile(file, "utf8")).toContain(
    "third.example.test {\n  reverse_proxy 127.0.0.1:3000",
  );
});

test("removing a route that was never applied neither rewrites the Caddyfile nor reloads Caddy, even without a trailing newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-"));
  roots.push(root);
  const file = join(root, "Caddyfile");
  const unrelated = "other.example.test {\n respond ok\n}";
  await writeFile(file, unrelated);
  const commands: string[][] = [];
  const router = createCaddyRouter({
    caddyfile: file,
    run: async ({ command }) => {
      commands.push([...command]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await router.remove("never/applied");
  expect(await readFile(file, "utf8")).toBe(unrelated);
  expect(commands).toEqual([]);
  await rm(file);
  await router.remove("never/applied");
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(commands).toEqual([]);
});

test("a route map renders in the order given with a withheld path answering 503, and is refused without a root path, with a wildcard, or with an upstream beyond this machine", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-map-"));
  roots.push(root);
  const file = join(root, "Caddyfile");
  const router = createCaddyRouter({
    caddyfile: file,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  await router.apply({
    key: "map",
    hostname: "app.test",
    routes: [
      { prefix: "/api/admin", upstream: "127.0.0.1:3003" },
      { prefix: "/api", upstream: null },
      { prefix: "/", upstream: "127.0.0.1:3001" },
    ],
  });
  const text = await readFile(file, "utf8");
  expect(text).toContain(
    [
      "  @rig0 path /api/admin /api/admin/*",
      "  handle @rig0 {",
      "    reverse_proxy 127.0.0.1:3003",
      "  }",
      "  @rig1 path /api /api/*",
      "  handle @rig1 {",
      "    respond 503",
      "  }",
      "  handle {",
      "    reverse_proxy 127.0.0.1:3001",
      "  }",
    ].join("\n"),
  );
  for (const routes of [
    [{ prefix: "/api", upstream: "127.0.0.1:3001" }],
    [
      { prefix: "/", upstream: "127.0.0.1:3001" },
      { prefix: "/api/*", upstream: "127.0.0.1:3002" },
    ],
    [{ prefix: "/", upstream: "10.0.0.5:3001" }],
  ])
    await expect(
      router.apply({ key: "map", hostname: "app.test", routes }),
    ).rejects.toMatchObject({ code: "ROUTE_INVALID" });
  expect(await readFile(file, "utf8")).toBe(text);
});

test("the router reports which published paths are withheld, and reloads a withdrawal the file already states but not an unchanged publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-caddy-withheld-"));
  roots.push(root);
  const file = join(root, "Caddyfile");
  const reloads: string[][] = [];
  const router = createCaddyRouter({
    caddyfile: file,
    run: async ({ command }) => {
      if (command[1] === "reload") reloads.push([...command]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  expect(await router.withheld("map")).toEqual([]);
  const withdrawal = {
    key: "map",
    hostname: "app.test",
    routes: [
      { prefix: "/api/admin", upstream: null },
      { prefix: "/api", upstream: "127.0.0.1:3002" },
      { prefix: "/", upstream: null },
    ],
  };
  await router.apply(withdrawal);
  expect(await router.withheld("map")).toEqual(["/api/admin", "/"]);
  expect(await router.withheld("other")).toEqual([]);
  // Caddy may be serving something older than the file: a withdrawal is never assumed to be live.
  const text = await readFile(file, "utf8");
  await router.apply(withdrawal);
  expect(reloads).toHaveLength(2);
  expect(await readFile(file, "utf8")).toBe(text);

  const lone = {
    key: "map",
    hostname: "app.test",
    routes: [{ prefix: "/", upstream: null }],
  };
  await router.apply(lone);
  expect(await router.withheld("map")).toEqual(["/"]);
  const published = {
    ...lone,
    routes: [{ prefix: "/", upstream: "127.0.0.1:3001" }],
  };
  await router.apply(published);
  await router.apply(published);
  expect(reloads).toHaveLength(4);
  expect(await router.withheld("map")).toEqual([]);
});
