import { expect, test } from "bun:test";
import { parse } from "yaml";
import {
  convertTarget,
  projectCandidate,
  reviewSchema,
  runCutover,
} from "../src/conversion/index";
import { legacyProjectSchema } from "../src/conversion/legacy-project";
import type { LegacyTarget } from "../src/conversion/legacy-state";

const WORKSPACE = "/rig/targets/p/t/revisions/r";
function saved(
  component: Record<string, unknown>,
  plan: Record<string, unknown> = {},
  record: Record<string, unknown> = {},
): LegacyTarget {
  return {
    id: "t",
    projectId: "p",
    name: "live",
    kind: "live",
    branch: "main",
    commit: "c".repeat(40),
    desired: "stopped",
    logRoot: "/rig/targets/p/t/logs",
    plan: {
      project: "demo",
      target: "live",
      workspacePath: WORKSPACE,
      dataRoot: "/rig/targets/p/t/data",
      components: [
        {
          name: "web",
          kind: "managed",
          env: {},
          dependsOn: [],
          command: "bun server.js",
          ...component,
        },
      ],
      ...plan,
    },
    ...record,
  } as LegacyTarget;
}
const review = (value: Record<string, unknown> = {}) =>
  reviewSchema.parse(value);
const planOf = (target: Record<string, unknown>) =>
  target.plan as {
    builds?: unknown[];
    components: Record<string, unknown>[];
  };

test("a Target with nothing the new runtime lacks starts from its saved plan, untouched otherwise", () => {
  const legacy = saved({ env: { PORT: "1" } }, { env: { SHARED: "lane" } }),
    result = convertTarget(legacy, review());
  expect(result.blockers).toEqual([]);
  expect(result.mapping.start).toBe("saved-plan");
  expect(result.target.conversion).toBeUndefined();
  expect(result.target.desired).toBe("stopped");
  expect(result.target.preparation).toBeUndefined();
  // Lane env was layered under Component env by the retired runtime; the saved Component now carries both.
  expect(planOf(result.target).components[0]!.env).toEqual({
    SHARED: "lane",
    PORT: "1",
  });
});

test("every hook needs its own decision, and only a managed preStart can be a build", () => {
  const legacy = saved(
    {
      hooks: { preStart: "make", postStop: "notify" },
      hookTimeout: 45,
    },
    { hooks: { preStart: "echo project" }, hookTimeout: 30 },
  );
  expect(
    convertTarget(legacy, review()).blockers.map((blocker) => [
      blocker.code,
      blocker.subject,
    ]),
  ).toEqual([
    ["unmapped_hook", "demo/@project/preStart"],
    ["unmapped_hook", "demo/web/preStart"],
    ["unmapped_hook", "demo/web/postStop"],
  ]);

  const decided = convertTarget(
    legacy,
    review({
      hooks: {
        "demo/@project/preStart": { as: "build" },
        "demo/web/preStart": { as: "build" },
        "demo/web/postStop": { as: "replaced", by: "an alert on the log" },
      },
    }),
  );
  // A Project hook ran once for the whole Target, not where a Service build runs: it is never silently a build.
  expect(
    decided.blockers.map((blocker) => [blocker.code, blocker.subject]),
  ).toEqual([["unsupported_hook_mapping", "demo/@project/preStart"]]);
  // The Component's own budget wins over the Project's, as it did for the hook.
  expect(planOf(decided.target).builds).toEqual([
    { id: "service:web", component: "web", command: "make", timeout: 45 },
  ]);
  expect(decided.mapping.start).toBe("needs-deploy");
  expect(decided.mapping.reasons).toEqual([
    "the postStop hook of web no longer runs (replaced by: an alert on the log)",
    "service:web never ran as a build, and no build success is invented for it",
  ]);
  expect(decided.target.conversion).toEqual({
    needsDeploy: decided.mapping.reasons,
  });
  expect(JSON.stringify(decided.target.plan)).not.toContain("notify");
});

test("budgets the retired runtime defaulted are written down, not left to a different default", () => {
  const hook = convertTarget(
      saved({ hooks: { preStart: "make" } }),
      review({ hooks: { "demo/web/preStart": { as: "build" } } }),
    ),
    tool = convertTarget(
      saved({ kind: "installed", entrypoint: "cli", build: "make cli" }),
      review(),
    );
  expect(hook.mapping.builds).toEqual([
    { id: "service:web", from: "hooks.preStart", timeout: 120 },
  ]);
  expect(tool.mapping.builds).toEqual([
    { id: "tool:web", from: "build", timeout: 600 },
  ]);
});

test("an env file keeps its exact path: outside the checkout it still loads, inside it a new Deployment is needed", () => {
  const outside = convertTarget(
      saved({ envFile: "/etc/demo/app.env" }),
      review(),
    ),
    inside = convertTarget(
      saved({ envFile: `${WORKSPACE}/app.env` }),
      review(),
    ),
    working = convertTarget(
      saved(
        { envFile: "/repo/app.env" },
        { workspacePath: "/repo" },
        {
          kind: "local",
          name: "local",
        },
      ),
      review(),
    );
  expect(planOf(outside.target).components[0]!.envFiles).toEqual([
    { path: "/etc/demo/app.env", required: true },
  ]);
  expect(outside.mapping.start).toBe("saved-plan");
  expect(inside.mapping.start).toBe("needs-deploy");
  // A Working copy is planned again from rig.yaml at every start, so nothing saved has to be redeployed.
  expect(working.mapping.start).toBe("working-copy");
  expect(working.target.conversion).toBeUndefined();
});

test("a command that names an inherited variable the new runtime drops blocks until it is acknowledged", () => {
  const legacy = saved({ command: "run --as $USER --shell ${SHELL}" });
  expect(
    convertTarget(legacy, review()).blockers.map((blocker) => blocker.code),
  ).toEqual(["ambient_name", "ambient_name"]);
  expect(
    convertTarget(legacy, review({ ambient: ["USER", "SHELL"] })).blockers,
  ).toEqual([]);
  // $USERNAME is another name.
  expect(
    convertTarget(saved({ command: "run $USERNAME" }), review()).blockers,
  ).toEqual([]);
});

test("unfinished work of the retired runtime blocks, and keepAlive false becomes restart no", () => {
  const blocked = convertTarget(
    saved(
      {},
      {},
      {
        kind: "preview",
        name: "feat",
        deploymentIncomplete: true,
        destructionPending: true,
      },
    ),
    review(),
  );
  expect(blocked.blockers.map((blocker) => blocker.code)).toEqual([
    "incomplete_deployment",
    "destruction_pending",
  ]);
  const quiet = convertTarget(
    saved({}, { daemon: { keepAlive: false } }),
    review(),
  );
  expect(planOf(quiet.target).components[0]!.restart).toBe("no");
});

test("the candidate rig.yaml maps lanes to roles and names what it cannot express", () => {
  const config = legacyProjectSchema.parse({
    name: "demo",
    domain: "${subdomain}.demo.test",
    hooks: { postStop: "notify" },
    components: {
      web: {
        mode: "managed",
        command: "serve --api ${api.url}",
        port: 3000,
        health: "http://127.0.0.1:${web.port}/health",
        dependsOn: ["api", "db"],
        envFile: "web.env",
        hooks: { preStart: "make web" },
      },
      api: { mode: "managed", command: "api ${mystery}", port: 3001 },
      db: { uses: "postgres", port: 5432 },
      cli: {
        mode: "installed",
        entrypoint: "bin/cli",
        installName: "demo-cli",
        build: "make cli",
      },
    },
    local: { envFile: "local.env", env: { MODE: "dev" } },
    live: {
      deployBranch: "release",
      envFile: "live.env",
      proxy: { upstream: "web" },
      providers: { processSupervisor: "launchd" },
      components: { web: { port: 3100 }, cli: { buildTimeout: 30 } },
    },
    deployments: { daemon: { keepAlive: false } },
  });
  const candidate = projectCandidate(
      config,
      review({ hooks: { "demo/web/preStart": { as: "build" } } }),
      "/rig/env",
    ),
    document = parse(candidate.yaml);
  // A reference with no equivalent is kept, named, and leaves the candidate unready rather than silently rewritten.
  expect(candidate.status).toBe("needs-editing");
  expect(document).toMatchObject({
    name: "demo",
    production_branch: "release",
    domain: "live.demo.test",
    supervisor: "launchd",
    proxy: { "/": "${services.web.ports.http}" },
    services: {
      web: {
        run: "serve --api http://127.0.0.1:${services.api.ports.http}",
        ready: "http://127.0.0.1:${services.web.ports.http}/health",
        depends_on: ["api"],
        build: "make web",
        build_timeout: "120s",
      },
    },
    tools: { "demo-cli": { build: "make cli", bin: "bin/cli" } },
    targets: {
      working: { domain: "local.demo.test", env: { MODE: "dev" } },
      stable: {
        services: { web: { ports: { http: 3100 } } },
        tools: { "demo-cli": { build_timeout: "30s" } },
      },
      preview: {
        domain: "${rig.target}.demo.test",
        services: { web: { restart: "no" }, api: { restart: "no" } },
      },
    },
  });
  expect(candidate.yaml).not.toContain("env_file");
  const notes = candidate.notes.join("\n");
  // Lane env files become the role files of the Host; the Component's becomes its all-roles file.
  expect(notes).toContain("/rig/env/demo/web/all.env");
  expect(notes).toContain("/rig/env/demo/working.env");
  expect(notes).toContain("/rig/env/demo/stable.env");
  expect(notes).toContain("components.db: Rig no longer provides Postgres");
  expect(notes).toContain("the dependency on db is dropped");
  expect(notes).toContain("${mystery} has no equivalent reference");
  expect(notes).toContain("Unknown reference");
  expect(notes).toContain("hooks.postStop: a Project hook has no equivalent");
});

test("every cutover command documents itself, and a wrong invocation fails with usage", async () => {
  const run = async (args: string[]) => {
    const written = { out: "", err: "" },
      code = await runCutover(args, {
        root: "/nonexistent/rig-root",
        output: {
          write: (text) => void (written.out += text),
          error: (text) => void (written.err += text),
        },
        pidAlive: () => false,
        now: () => "now",
      });
    return { code, ...written };
  };
  for (const command of ["inventory", "preview", "apply", "rollback"])
    for (const flag of ["--help", "-h"]) {
      const help = await run([command, flag]);
      expect(help.code).toBe(0);
      expect(help.out).toContain(`Usage: bun run cutover ${command}`);
    }
  expect((await run(["--help"])).out).toContain("rollback --backup");
  expect(await run(["apply", "--revision", "abc"])).toMatchObject({
    code: 1,
    err: expect.stringContaining("USAGE: --review is required."),
  });
  expect(await run(["migrate"])).toMatchObject({ code: 1, out: "" });
  // A root with no state has nothing to convert.
  expect(JSON.parse((await run(["inventory"])).out)).toMatchObject({
    status: "empty",
    blockers: [],
  });
});
