import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectProxyPublication,
  proxyCheck,
} from "../src/adapters/proxy-publication";
import { inspectHost } from "../src/adapters/host-inspection";
import { projectStatus } from "../src/runtime/project-status";
import { timerObservationDeadline } from "../src/runtime/bounded-observations";
import { renderStatus } from "../src/cli/output";
import { parseProjectConfig, resolveTargetPlan as resolvePlanWithHost } from "../src/config";
import type { TargetRecord } from "../src/domain/runtime";
const RESOLVE_HOST = { operatorHome: "/home/operator", envRoot: "/rig/env" };
const resolveTargetPlan = (input: Parameters<typeof resolvePlanWithHost>[0]) =>
  resolvePlanWithHost(input, RESOLVE_HOST);

const proxyFile = "/rig/proxy/Caddyfile";
const block = "# rig begin abc\nexample.test {\n  reverse_proxy 127.0.0.1:4000\n}\n# rig end abc\n";
function files(map: Record<string, string>) {
  return async (file: string) => map[file];
}

test("a host Caddyfile that imports the proxy file publishes its routes", async () => {
  for (const line of [
    `import ${proxyFile}`,
    "import {$HOME}/proxy/Caddyfile",
    "import {env.HOME}/proxy/Caddyfile",
    "import /rig/proxy/*",
    "import ../../rig/proxy/Caddyfile",
    "\timport /rig/proxy/Caddyfile # trailing comment",
  ]) {
    const publication = await inspectProxyPublication({
      proxyFile,
      hostCaddyfiles: ["/missing/Caddyfile", "/etc/caddy/Caddyfile"],
      environment: { HOME: "/rig" },
      read: files({
        [proxyFile]: block,
        "/etc/caddy/Caddyfile": `example.com {\n  respond ok\n}\n${line}\n`,
      }),
    });
    expect(publication).toEqual({
      proxyFile,
      routes: 1,
      hostCaddyfile: "/etc/caddy/Caddyfile",
      state: "imported",
    });
  }
});

test("routes are unpublished when no host Caddyfile imports the proxy file", async () => {
  const unpublished = await inspectProxyPublication({
    proxyFile,
    hostCaddyfiles: ["/etc/caddy/Caddyfile"],
    environment: {},
    read: files({
      [proxyFile]: block + block.replace(/abc/g, "def"),
      "/etc/caddy/Caddyfile": "example.com {\n  respond ok\n}\nimport /other/Caddyfile\n# import /rig/proxy/Caddyfile\n",
    }),
  });
  expect(unpublished).toEqual({
    proxyFile,
    routes: 2,
    hostCaddyfile: "/etc/caddy/Caddyfile",
    state: "unpublished",
  });
  const check = proxyCheck(unpublished);
  expect(check).toMatchObject({ name: "caddy-proxy", ok: false, reason: "proxy-unpublished" });
  expect(check.message).toContain("/etc/caddy/Caddyfile");
  expect(check.message).toContain(proxyFile);
  expect(check.hint).toContain(`import ${proxyFile}`);

  const missing = await inspectProxyPublication({
    proxyFile,
    hostCaddyfiles: ["/etc/caddy/Caddyfile"],
    environment: {},
    read: files({ [proxyFile]: block }),
  });
  expect(missing).toEqual({ proxyFile, routes: 1, state: "unpublished" });
  expect(proxyCheck(missing)).toMatchObject({ ok: false, reason: "proxy-unpublished" });
  expect(proxyCheck(missing).message).toContain(proxyFile);
});

test("writing routes straight into the host Caddyfile, or having no routes, is not a problem", async () => {
  const direct = await inspectProxyPublication({
    proxyFile: "/etc/caddy/Caddyfile",
    hostCaddyfiles: ["/etc/caddy/Caddyfile"],
    environment: {},
    read: files({ "/etc/caddy/Caddyfile": block }),
  });
  expect(direct).toEqual({
    proxyFile: "/etc/caddy/Caddyfile",
    routes: 1,
    hostCaddyfile: "/etc/caddy/Caddyfile",
    state: "direct",
  });
  expect(proxyCheck(direct)).toMatchObject({ name: "caddy-proxy", ok: true });
  const unused = await inspectProxyPublication({
    proxyFile,
    hostCaddyfiles: ["/etc/caddy/Caddyfile"],
    environment: {},
    read: files({}),
  });
  expect(unused).toEqual({ proxyFile, routes: 0, state: "unpublished" });
  expect(proxyCheck(unused)).toMatchObject({ name: "caddy-proxy", ok: true });
});

test("rig doctor reports an inert proxy file from the configured host Caddyfile", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-proxy-"));
  try {
    const hostCaddyfile = join(root, "host", "Caddyfile");
    await mkdir(join(root, "host"), { recursive: true });
    await mkdir(join(root, "proxy"), { recursive: true });
    await writeFile(hostCaddyfile, "example.com {\n  respond ok\n}\n");
    await writeFile(join(root, "proxy", "Caddyfile"), block);
    await writeFile(
      join(root, "config.yaml"),
      `providers:\n  caddy:\n    host_caddyfile: ${hostCaddyfile}\n`,
    );
    const failing = (await inspectHost(root)).find((c) => c.name === "caddy-proxy");
    expect(failing).toMatchObject({ ok: false, reason: "proxy-unpublished" });
    expect(failing?.message).toContain(hostCaddyfile);
    await writeFile(hostCaddyfile, `import ${join(root, "proxy", "Caddyfile")}\n`);
    expect((await inspectHost(root)).find((c) => c.name === "caddy-proxy")).toMatchObject({ ok: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rig status marks a route unpublished when the host Caddy does not load it", async () => {
  const config = parseProjectConfig({
    name: "app",
    domain: "app.example.test",
    services: { web: { run: "serve", ports: { http: 4000 } } },
    proxy: { "/": "${services.web.ports.http}" },
  });
  const plan = resolveTargetPlan({
    config,
    target: "live",
    workspacePath: "/w",
    dataRoot: "/d",
    deploymentName: "live",
    branchSlug: "main",
    branch: "main",
    assignedPorts: { web: 4000 },
  });
  const target: TargetRecord = {
    id: "t",
    projectId: "p",
    name: "live",
    kind: "live",
    branch: "main",
    plan,
    desired: "running",
    createdAt: "now",
    updatedAt: "now",
    logRoot: "/logs",
  };
  const observations = {
    async process() {
      return { state: "running" as const, pid: 1 };
    },
    async health() {
      return { ready: true as const };
    },
    async artifact() {
      return "installed" as const;
    },
    async persistent() {
      return true;
    },
  };
  const status = (state: "imported" | "unpublished") =>
    projectStatus(
      { name: "app", repoPath: "/repo" },
      [target],
      { target: "live" },
      {
        inProgress: () => false,
        observations,
        observationBudgetMs: 2000,
        observationDeadline: timerObservationDeadline,
        documents: {
          async read() {
            return { path: "/repo/rig.yaml", revision: "r", config };
          },
        },
        async inspectProxy() {
          return { proxyFile, routes: 1, hostCaddyfile: "/etc/caddy/Caddyfile", state };
        },
      },
    );
  const inert = await status("unpublished");
  expect(inert.targets[0]).toMatchObject({ route: "app.example.test", routePublished: false });
  expect(renderStatus(inert)).toContain("app.example.test  unpublished");
  expect(inert.warnings).toContain(
    `Routes are unpublished: /etc/caddy/Caddyfile does not import ${proxyFile}. Run rig doctor.`,
  );
  const published = await status("imported");
  expect(published.targets[0]?.routePublished).toBeUndefined();
  expect(renderStatus(published)).not.toContain("unpublished");
});

test("rig doctor names the caddy executable as a provider capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-proxy-caddy-"));
  try {
    const check = (await inspectHost(root)).find((c) => c.name === "provider/caddy");
    expect(check).toMatchObject({ name: "provider/caddy", ok: Bun.which("caddy") !== null });
    if (!check?.ok)
      expect(check).toMatchObject({ reason: "missing-capability", hint: "Install caddy and include it in PATH." });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a command reload mode without a command is one invalid host config, not a separate caddy-reload check", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-reload-"));
  try {
    await writeFile(join(root, "config.yaml"), "providers:\n  caddy:\n    reload:\n      mode: command\n");
    const checks = await inspectHost(root);
    expect(checks.map((check) => check.name)).not.toContain("caddy-reload");
    const host = checks.find((check) => check.name === "host-config");
    expect(host).toMatchObject({ ok: false, reason: "config-invalid" });
    expect(`${host?.message} ${host?.hint}`).toContain("providers.caddy.reload.command");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
