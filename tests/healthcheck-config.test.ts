import { expect, test } from "bun:test";
import {
  parseProjectConfig,
  resolveTargetPlan as resolvePlanWithHost,
  scaffoldProjectConfig,
} from "../src/config/index.js";
import type { ManagedComponent, ProjectConfig } from "../src/config/types";

/** ADR 0012: a Service's healthcheck is Docker Compose's, read into the plan's start check and ongoing checks. */

const host = { operatorHome: "/home/operator", envRoot: "/rig/env" };
const roots = { workspacePath: "/work", dataRoot: "/data" };
const web = (extra: Record<string, unknown> = {}) => ({
  web: { command: "serve", ports: { http: 4100 }, ...extra },
});
/** The web Service as the given role's plan resolves it. */
function planned(
  config: unknown,
  target: "working" | "stable" | "preview" = "working",
): ManagedComponent {
  const plan = resolvePlanWithHost(
    {
      config: config as ProjectConfig,
      target,
      ...roots,
      ...(target === "preview" ? { assignedPorts: { "web.http": 4100 } } : {}),
    },
    host,
  );
  return plan.components.find(
    (component): component is ManagedComponent =>
      component.kind === "managed" && component.name === "web",
  )!;
}
/** The issues a parse refused, path and message each; empty when it was accepted. */
function issuesOf(input: unknown): { path: string; message: string }[] {
  try {
    parseProjectConfig(input);
    return [];
  } catch (error) {
    const issues =
      (
        error as {
          context?: { issues?: { path: string[]; message: string }[] };
        }
      ).context?.issues ?? [];
    return issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
  }
}

test("a healthcheck with only a test plans Compose's defaults and Rig's 30s start_period", () => {
  expect(
    planned({
      name: "app",
      services: web({
        healthcheck: { test: "curl -f http://127.0.0.1:${port}/" },
      }),
    }),
  ).toMatchObject({
    health: "curl -f http://127.0.0.1:4100/",
    readyTimeout: 30,
    healthcheck: { interval: 30, timeout: 30, retries: 3, onFailure: "report" },
  });
  expect(
    planned({
      name: "app",
      services: web({
        healthcheck: {
          test: "http://127.0.0.1:${port}/health",
          interval: "1m",
          timeout: "5s",
          retries: 5,
          start_period: "2m",
          on_failure: "restart",
        },
      }),
    }),
  ).toMatchObject({
    health: "http://127.0.0.1:4100/health",
    readyTimeout: 120,
    healthcheck: { interval: 60, timeout: 5, retries: 5, onFailure: "restart" },
  });
});

test("without a healthcheck the plan is what it was before healthcheck: a 30s port wait and no ongoing checks", () => {
  const component = planned({ name: "app", services: web() });
  expect(component.readyTimeout).toBe(30);
  expect(component).not.toHaveProperty("health");
  expect(component).not.toHaveProperty("healthcheck");
});

test("a string test is a shell command unless it starts with http:// or https://; a leading / is a command, not a path on the port", () => {
  for (const [test, health] of [
    ["/usr/local/bin/check --quick", "/usr/local/bin/check --quick"],
    ["/health", "/health"],
    ["HTTPS://localhost:${port}/up", "HTTPS://localhost:4100/up"],
  ] as const)
    expect(
      planned({ name: "app", services: web({ healthcheck: { test } }) }).health,
    ).toBe(health);
  // A shell command's inputs guard the plan like the command's; a URL is not run by a shell and has none.
  const shell = planned({
    name: "app",
    environment: { FLAG: "--quick" },
    services: web({ healthcheck: { test: "check ${environment.FLAG}" } }),
  });
  expect(shell.commandInputs).toEqual([
    { name: "FLAG", source: "environment.FLAG", value: "--quick" },
  ]);
});

test("CMD-SHELL runs its command as a string test does; CMD runs the program with exactly its arguments", () => {
  expect(
    planned({
      name: "app",
      services: web({
        healthcheck: {
          test: ["CMD-SHELL", "test -f ${rig.data}/up || exit 1"],
        },
      }),
    }).health,
  ).toBe("test -f /data/web/up || exit 1");
  const exec = planned({
    name: "app",
    environment: { NOTE: "it's up; rm -rf /" },
    services: web({
      healthcheck: {
        test: [
          "CMD",
          "check",
          "--port",
          "${port}",
          "two words",
          "${environment.NOTE}",
          "$HOME",
        ],
      },
    }),
  });
  // No argument is split, expanded or run as shell code.
  expect(exec.health).toBe(
    `'check' '--port' '4100' 'two words' 'it'\\''s up; rm -rf /' '$HOME'`,
  );
  expect(exec.commandInputs).toEqual([
    { name: "NOTE", source: "environment.NOTE", value: "it's up; rm -rf /" },
  ]);
  // A program that reads like a URL is still a program, never the HTTP check.
  expect(
    planned({
      name: "app",
      services: web({
        healthcheck: { test: ["CMD", "http://127.0.0.1:4100/up"] },
      }),
    }).health,
  ).toBe("'http://127.0.0.1:4100/up'");
});

test("a CMD word is never shell syntax: an assignment, a parenthesis or an empty argument reaches the program as written", async () => {
  const run = async (test: string[]) => {
    const command = planned({
      name: "app",
      services: web({ healthcheck: { test } }),
    }).health!;
    const child = Bun.spawn(["/bin/sh", "-c", command], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return { command, exitCode: await child.exited };
  };
  // Unquoted, sh would read this as an assignment, run nothing, and pass.
  expect(await run(["CMD", "NO_SUCH_PROBE=1"])).toEqual({
    command: "'NO_SUCH_PROBE=1'",
    exitCode: 127,
  });
  expect((await run(["CMD", "("])).exitCode).toBe(127);
  // Empty arguments are arguments: test "" = "" is true.
  expect(await run(["CMD", "/bin/test", "", "=", ""])).toEqual({
    command: "'/bin/test' '' '=' ''",
    exitCode: 0,
  });
});

test('["NONE"] and disable: true leave the Service as if it had no healthcheck, start_period included', () => {
  for (const healthcheck of [
    { test: ["NONE"], start_period: "5m" },
    { test: "true", start_period: "5m", disable: true },
  ]) {
    const component = planned({ name: "app", services: web({ healthcheck }) });
    expect(component.readyTimeout).toBe(30);
    expect(component).not.toHaveProperty("health");
    expect(component).not.toHaveProperty("healthcheck");
  }
});

test("a Target patch merges into the inherited healthcheck key by key, and disable: true turns it off for that role", () => {
  const config = {
    name: "app",
    services: web({
      healthcheck: { test: "http://127.0.0.1:${port}/health", retries: 2 },
    }),
    targets: {
      working: { services: { web: { healthcheck: { disable: true } } } },
      stable: {
        services: {
          web: { healthcheck: { interval: "10s", on_failure: "restart" } },
        },
      },
      preview: {
        services: { web: { healthcheck: { test: ["CMD", "probe"] } } },
      },
    },
  };
  expect(planned(config, "working")).not.toHaveProperty("healthcheck");
  expect(planned(config, "stable")).toMatchObject({
    health: "http://127.0.0.1:4100/health",
    healthcheck: { interval: 10, retries: 2, onFailure: "restart" },
  });
  expect(planned(config, "preview")).toMatchObject({
    health: "'probe'",
    healthcheck: { interval: 30, retries: 2, onFailure: "report" },
  });
});

test("a healthcheck without a test checks the declared ports, and is refused on a Service that declares none", () => {
  const component = planned({
    name: "app",
    services: web({
      healthcheck: { start_period: "2m", on_failure: "restart" },
    }),
  });
  expect(component).not.toHaveProperty("health");
  expect(component).toMatchObject({
    readyTimeout: 120,
    healthcheck: { onFailure: "restart" },
  });
  expect(
    issuesOf({
      name: "app",
      services: {
        worker: { command: "work", healthcheck: { interval: "1m" } },
      },
    }),
  ).toEqual([
    {
      path: "services.worker.healthcheck",
      message:
        "Service 'worker' declares no port, so its healthcheck needs a test, such as test: test -f /tmp/worker.alive.",
    },
  ]);
  // A worker without a port gives its own test, such as a heartbeat file it touches.
  expect(
    issuesOf({
      name: "app",
      services: {
        worker: {
          command: "work",
          healthcheck: {
            test: 'test -n "$(find ${rig.data}/heartbeat -mmin -2)"',
          },
        },
      },
    }),
  ).toEqual([]);
});

test.each([
  [["CURL", "x"], 'a list test must start with "CMD", "CMD-SHELL" or "NONE"'],
  [
    ["CMD"],
    'CMD needs a program to run, such as ["CMD", "pg_isready", "-h", "127.0.0.1"]',
  ],
  [
    ["CMD", "", "x"],
    'CMD needs a program to run, such as ["CMD", "pg_isready", "-h", "127.0.0.1"]',
  ],
  [
    ["CMD-SHELL", " "],
    'CMD-SHELL takes exactly one shell command, such as ["CMD-SHELL", "curl -f http://127.0.0.1:${port}/health"]',
  ],
  [
    ["CMD-SHELL", "a", "b"],
    'CMD-SHELL takes exactly one shell command, such as ["CMD-SHELL", "curl -f http://127.0.0.1:${port}/health"]',
  ],
  [["NONE", "x"], '["NONE"] takes nothing after NONE; write test: ["NONE"]'],
  [
    ["CMD-SHELL", "http://127.0.0.1:${port}/"],
    "an HTTP check is written as a plain string, such as test: http://127.0.0.1:${port}/health; CMD-SHELL runs a shell command",
  ],
  [
    ["CMD", "probe", "--bind", "0.0.0.0"],
    "Health checks must address 127.0.0.1 or localhost.",
  ],
  [
    "http://example.com/health",
    "Health checks must address 127.0.0.1 or localhost.",
  ],
])("test %j is refused: %s", (test, message) => {
  expect(
    issuesOf({ name: "app", services: web({ healthcheck: { test } }) }),
  ).toEqual([{ path: "services.web.healthcheck.test", message }]);
});

test("intervals are at least 5s, retries at least 1, on_failure report or restart, and Compose keys Rig does not take are refused", () => {
  expect(
    issuesOf({
      name: "app",
      services: web({
        healthcheck: {
          interval: "4s",
          retries: 0,
          on_failure: "alert",
          start_interval: "5s",
        },
      }),
    }).map((issue) => issue.path),
  ).toEqual([
    "services.web.healthcheck.interval",
    "services.web.healthcheck.retries",
    "services.web.healthcheck.on_failure",
    // start_interval: Compose's, not Rig's.
    "services.web.healthcheck",
  ]);
});

test("references in a test are checked when rig.yaml is read, at the list entry that holds them", () => {
  expect(
    issuesOf({
      name: "app",
      services: web({
        healthcheck: { test: ["CMD", "probe", "${services.nope.port}"] },
      }),
    }),
  ).toEqual([
    {
      path: "services.web.healthcheck.test.2",
      message:
        "Unknown reference '${services.nope.port}' in services.web.healthcheck.test.2: 'nope' is not a declared Service.",
    },
  ]);
});

test("ready and ready_timeout are refused wherever a Service is spelled, naming where each moved", () => {
  expect(
    issuesOf({
      name: "app",
      services: web({ ready: "http://127.0.0.1:4100/", ready_timeout: "1m" }),
      targets: {
        stable: { services: { web: { ready_timeout: "2m" } } },
      },
    }),
  ).toEqual([
    {
      path: "services.web.ready",
      message: "`ready` is now `healthcheck.test`; move it there",
    },
    {
      path: "services.web.ready_timeout",
      message: "`ready_timeout` is now `healthcheck.start_period`",
    },
    {
      path: "targets.stable.services.web.ready_timeout",
      message: "`ready_timeout` is now `healthcheck.start_period`",
    },
  ]);
});

test("rig init writes its --healthcheck as the Service's healthcheck test", () => {
  expect(
    scaffoldProjectConfig({
      name: "app",
      service: {
        name: "web",
        command: "serve",
        healthcheck: "http://127.0.0.1:${port}/health",
      },
    }).services!.web,
  ).toEqual({
    command: "serve",
    ports: { http: "auto" },
    healthcheck: { test: "http://127.0.0.1:${port}/health" },
  });
});
