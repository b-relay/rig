import { expect, test } from "bun:test";
import { judgeCertificate } from "../src/domain/certificate-check";
import { commandSchema, readActions } from "../src/daemon/protocol";
import { renderResult } from "../src/cli/output";
import { createRigCommand } from "../src/cli/commands";
import type { RuntimeCommand } from "../src/daemon/protocol";
import type { LocalCommands } from "../src/cli/types";

const now = new Date("2026-10-10T00:00:00.000Z");
const days = (count: number) => new Date(now.getTime() + count * 86_400_000);

test("a served certificate is ready with more than seven days left from a production CA; staging passes only when allowed", () => {
  const production = { O: "Let's Encrypt", CN: "E7" };
  expect(
    judgeCertificate(
      "app.test",
      { issuer: production, validTo: days(60) },
      now,
      false,
    ),
  ).toMatchObject({ ok: true, issuer: "Let's Encrypt / E7" });
  expect(
    judgeCertificate(
      "app.test",
      { issuer: production, validTo: days(3) },
      now,
      false,
    ),
  ).toMatchObject({ ok: false, problem: "its certificate expires in 3 days" });
  expect(
    judgeCertificate(
      "app.test",
      { issuer: production, validTo: days(-1) },
      now,
      false,
    ),
  ).toMatchObject({ ok: false, problem: "its certificate has expired" });
  const staging = {
    O: "(STAGING) Let's Encrypt",
    CN: "(STAGING) Ersatz Edamame E1",
  };
  expect(
    judgeCertificate(
      "app.test",
      { issuer: staging, validTo: days(60) },
      now,
      false,
    ),
  ).toMatchObject({
    ok: false,
    problem: "its certificate comes from a staging CA",
  });
  expect(
    judgeCertificate(
      "app.test",
      { issuer: staging, validTo: days(60) },
      now,
      true,
    ),
  ).toMatchObject({ ok: true });
});

test("proxy is a read and proxy-apply a mutation on the control plane", () => {
  expect(commandSchema.parse({ action: "proxy" })).toEqual({ action: "proxy" });
  expect(commandSchema.parse({ action: "proxy-apply" })).toEqual({
    action: "proxy-apply",
  });
  expect(readActions.has("proxy")).toBe(true);
  expect(readActions.has("proxy-apply")).toBe(false);
});

async function run(args: string[], local?: Partial<LocalCommands>) {
  const requests: RuntimeCommand[] = [];
  const written: string[] = [];
  const command = createRigCommand(
    "/work",
    { write: (text) => written.push(text), error: () => {} },
    async (request) => {
      requests.push(request);
    },
    () => now,
    {
      proxyToken: async () => "/r/auth/acme-dns.token",
      proxyVerify: async () => [],
      ...local,
    },
  );
  command.exitOverride();
  const error = await command.parseAsync(args, { from: "user" }).then(
    () => undefined,
    (caught) => caught,
  );
  return { requests, output: written.join(""), error };
}

test("rig proxy reads the report and rig proxy reload applies through rigd", async () => {
  expect((await run(["proxy"])).requests).toEqual([
    { action: "proxy", repoPath: "/work" },
  ]);
  expect((await run(["proxy", "reload"])).requests).toEqual([
    { action: "proxy-apply", repoPath: "/work" },
  ]);
});

test("rig proxy verify prints each hostname and fails when any is not ready", async () => {
  let asked: unknown;
  const ready = await run(
    ["proxy", "verify", "--port", "28443", "--wait", "30", "--staging-ok"],
    {
      proxyVerify: async (options) => {
        asked = options;
        return [
          {
            hostname: "app.example.com",
            ok: true,
            issuer: "Let's Encrypt / E7",
            validTo: "2026-12-01T00:00:00.000Z",
          },
        ];
      },
    },
  );
  expect(asked).toEqual({ port: 28443, waitSeconds: 30, stagingOk: true });
  expect(ready.error).toBeUndefined();
  expect(ready.output).toBe(
    "ok    app.example.com  Let's Encrypt / E7, until 2026-12-01\nAll 1 hostnames are ready.\n",
  );
  const failing = await run(["proxy", "verify"], {
    proxyVerify: async () => [
      {
        hostname: "a.example.com",
        ok: true,
        issuer: "x",
        validTo: "2026-12-01T00:00:00.000Z",
      },
      {
        hostname: "b.example.com",
        ok: false,
        problem: "nothing listens on 127.0.0.1:443",
      },
    ],
  });
  expect(failing.output).toContain(
    "FAIL  b.example.com  nothing listens on 127.0.0.1:443\n",
  );
  expect(failing.error).toMatchObject({ code: "PROXY_NOT_READY" });
});

test("the proxy report names each site's owner, routes and certificate, and a pending custom file", () => {
  expect(
    renderResult("proxy", {
      caddy: {
        state: "running",
        ports: { http: 80, https: 443 },
        ca: "letsencrypt",
        generation: "g7",
      },
      sites: [
        {
          hostname: "api.melody.example.com",
          source: "target",
          project: "melody",
          target: "stable",
          routes: [
            { prefix: "/v1", upstream: null },
            { prefix: "/", upstream: "127.0.0.1:3002" },
          ],
          certificate: "*.melody.example.com",
        },
        {
          hostname: "code.example.com",
          source: "custom",
          certificate: "*.example.com",
        },
      ],
      custom: [
        { file: "/r/proxy/custom.caddy", state: "pending" },
        { file: "/r/proxy/custom-global.caddy", state: "applied" },
      ],
    }),
  ).toBe(
    [
      "Caddy      running on ports 80 and 443, certificates from letsencrypt",
      "Generation g7",
      "",
      "api.melody.example.com  melody stable  /v1 -> withheld (503), / -> 127.0.0.1:3002  [*.melody.example.com]",
      "code.example.com  custom.caddy  [*.example.com]",
      "",
      "/r/proxy/custom.caddy  changed since applied; run rig proxy reload",
      "/r/proxy/custom-global.caddy  applied",
      "",
    ].join("\n"),
  );
});
