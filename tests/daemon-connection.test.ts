import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDaemon } from "../src/daemon/connection";

test("discovery re-reads the address and credentials for each command after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rig-connection-"));
  const root = join(directory, ".rig");
  const servers: ReturnType<typeof Bun.serve>[] = [];
  try {
    await mkdir(join(root, "daemon"), { recursive: true });
    await mkdir(join(root, "auth"), { recursive: true });
    for (const generation of [1, 2]) {
      const token = `token-${generation}`;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
        return Response.json({ result: { project: `generation-${generation}`, targets: [] } });
      }});
      servers.push(server);
      await writeFile(join(root, "daemon/address.json"), JSON.stringify({ port: server.port, pid: 1, instanceId: token }));
      await writeFile(join(root, "auth/control-plane.token"), token);
      const client = await connectDaemon(root);
      expect(await client.status({ project: `generation-${generation}` })).toEqual({ project: `generation-${generation}`, targets: [] });
      await server.stop(true);
    }
  } finally {
    for (const server of servers) await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale address record is reported as a stopped daemon and its port never receives the token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rig-stale-address-"));
  const root = join(directory, ".rig");
  const received: string[] = [];
  const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    received.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get("authorization")}`);
    return Response.json({ instanceId: "fixture", pid: 2147483647, running: true });
  }});
  try {
    await mkdir(join(root, "daemon"), { recursive: true });
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(join(root, "daemon/address.json"), JSON.stringify({ port: foreign.port, pid: 2147483647, instanceId: "fixture" }));
    await writeFile(join(root, "auth/control-plane.token"), "long-lived-secret");
    await expect(connectDaemon(root)).rejects.toMatchObject({
      code: "DAEMON_UNREACHABLE",
      message: expect.stringContaining("stale"),
    });
    expect(received).toEqual([]);
  } finally {
    await foreign.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Doctor uses captured or explicit repo paths and only falls back for missing or unreachable setup", async () => {
  const { createCliClient } = await import("../src/index");
  const directory = await mkdtemp(join(tmpdir(), "rig-doctor-"));
  const root = join(directory, ".rig");
  let response = Response.json({ error: { code: "UNAUTHORIZED", message: "Invalid token" } }, { status: 401 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => response.clone() });
  try {
    const captured = join(directory, "captured");
    const explicit = join(directory, "explicit");
    for (const [path, name] of [[captured, "captured"], [explicit, "explicit"]] as const) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "rig.json"), JSON.stringify({ name, components: {} }));
    }
    const client = createCliClient(root, captured);
    expect(await client.command({ action: "doctor" })).toMatchObject({ ok: false, checks: expect.arrayContaining([expect.objectContaining({ message: "Project 'captured' configuration is valid." })]) });
    expect(await client.command({ action: "doctor", repoPath: explicit })).toMatchObject({ ok: false, checks: expect.arrayContaining([expect.objectContaining({ message: "Project 'explicit' configuration is valid." })]) });
    await expect(client.status({ project: "demo" })).rejects.toMatchObject({ code: "DAEMON_MISSING", hint: "Run rigd install to start the daemon." });
    await mkdir(join(root, "daemon"), { recursive: true });
    await writeFile(join(root, "daemon/address.json"), "not-json");
    await expect(client.command({ action: "doctor" })).rejects.toMatchObject({ code: "DAEMON_STATE" });
    await writeFile(join(root, "daemon/address.json"), JSON.stringify({ port: server.port, pid: 1, instanceId: "fixture" }));
    await expect(connectDaemon(root)).rejects.toMatchObject({ code: "DAEMON_MISSING", hint: "Run 'rigd install' to set up the daemon." });
    expect(await client.command({ action: "doctor" })).toMatchObject({ ok: false });
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(join(root, "auth/control-plane.token"), "wrong-token");
    await expect(client.command({ action: "doctor" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    response = Response.json({ accepted: true });
    await expect(client.command({ action: "doctor" })).rejects.toMatchObject({ code: "DAEMON_PROTOCOL" });
    await expect(client.status({ project: "demo" })).rejects.toMatchObject({ code: "DAEMON_PROTOCOL" });
    await server.stop(true);
    expect(await client.command({ action: "doctor" })).toMatchObject({ ok: false });
    await expect(client.command({ action: "list" })).rejects.toMatchObject({ code: "DAEMON_UNREACHABLE" });
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote discovery never turns unavailable, rejected or acceptance-only replies into successful pushes", async () => {
  const { runRemoteHelper } = await import("../src/git/remote-helper");
  const directory = await mkdtemp(join(tmpdir(), "rig-remote-connection-"));
  const root = join(directory, ".rig");
  let response = Response.json({ result: { outcome: "deployed" } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => response.clone() });
  try {
    for (const scenario of ["missing", "deployed", "rejected", "accepted", "unreachable"]) {
      if (scenario === "deployed") {
        await mkdir(join(root, "daemon"), { recursive: true });
        await mkdir(join(root, "auth"), { recursive: true });
        await writeFile(join(root, "daemon/address.json"), JSON.stringify({ port: server.port, pid: 1, instanceId: "fixture" }));
        await writeFile(join(root, "auth/control-plane.token"), "token");
      }
      if (scenario === "rejected") response = Response.json({ error: { code: "REJECTED", message: "Deploy rejected" } }, { status: 409 });
      if (scenario === "accepted") response = Response.json({ result: { accepted: true } });
      if (scenario === "unreachable") await server.stop(true);
      let output = "";
      const exit = await runRemoteHelper("rig://localhost/example", {
        repoPath: directory,
        input: (async function* () { yield* ["push refs/heads/main:refs/heads/main", "", ""]; })(),
        output: { write(value) { output += value; }, error() {} },
        client: { async command(command) { return (await connectDaemon(root)).command(command); } },
        source: { async resolve() { return "a".repeat(40); }, async verifyBranch() {} },
        newOperationId: () => "connection-push",
      });
      expect(exit).toBe(scenario === "deployed" ? 0 : 1);
      expect(output.includes("ok refs/heads/main")).toBe(scenario === "deployed");
    }
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an empty or unreadable credential is reported by its path, never as a missing installation", async () => {
  const { isDaemonUnavailable } = await import("../src/daemon/connection");
  const { chmod } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "rig-token-"));
  const root = join(directory, ".rig");
  const tokenPath = join(root, "auth", "control-plane.token");
  const received: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    received.push(request.url);
    return Response.json({ result: {} });
  }});
  try {
    await mkdir(join(root, "daemon"), { recursive: true });
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(join(root, "daemon/address.json"), JSON.stringify({ port: server.port, pid: process.pid, instanceId: "self" }));
    await writeFile(tokenPath, "  \n");
    const empty = await connectDaemon(root).catch((error) => error);
    expect(empty).toMatchObject({ code: "DAEMON_TOKEN", details: { path: tokenPath } });
    expect(empty.message).toBe(`The daemon credential at ${tokenPath} is empty.`);
    expect(isDaemonUnavailable(empty)).toBe(false);
    await writeFile(tokenPath, "secret");
    await chmod(tokenPath, 0o000);
    const unreadable = await connectDaemon(root).catch((error) => error);
    expect(unreadable).toMatchObject({ code: "DAEMON_TOKEN", details: { path: tokenPath, cause: "EACCES" } });
    expect(unreadable.message).toBe(`The daemon credential at ${tokenPath} cannot be read (EACCES).`);
    expect(unreadable.hint).toContain("mode 600");
    await chmod(tokenPath, 0o600);
    expect(received).toEqual([]);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
