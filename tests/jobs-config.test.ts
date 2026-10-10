import { expect, test } from "bun:test";
import {
  configJsonSchemas,
  parseProjectConfig,
  resolveTargetPlan,
  type ProjectConfig,
  type TargetRole,
} from "../src/config/index.js";

const HOST = { operatorHome: "/home/operator", envRoot: "/rig/env" };
/** Melody's shape: an api and its databases, and jobs that reach them and share the api's cache. */
const melody = (jobs: Record<string, unknown>): unknown => ({
  name: "melody",
  environment: { NODE_ENV: "production" },
  services: {
    api: { command: "serve --port ${port}", ports: { http: 4000 } },
    postgres: { command: "pg --port ${port}", ports: { pg: 5432 } },
    typesense: {
      command: "ts --port ${ports.api}",
      ports: { api: 8108, peer: 8107 },
    },
  },
  jobs,
  targets: { working: true, stable: true, preview: true },
});
function plan(config: unknown, target: TargetRole = "stable") {
  return resolveTargetPlan(
    {
      config: parseProjectConfig(config) as ProjectConfig,
      target,
      workspacePath: "/srv/melody",
      dataRoot: "/rig/data",
      ...(target === "preview" ? { deploymentName: "feat-x-1a2b3c4d" } : {}),
      assignedPorts: {
        "api.http": 4100,
        "postgres.pg": 5500,
        "typesense.api": 8200,
        "typesense.peer": 8201,
      },
    },
    HOST,
  );
}
/** The hint a refused config gives, or undefined when it is accepted. */
function refusal(config: unknown): string | undefined {
  try {
    parseProjectConfig(config);
    return undefined;
  } catch (error) {
    return (error as { hint: string }).hint;
  }
}

test("a job is planned with its command, schedule, zone and limits, scheduled in the stable Target only by default", () => {
  const config = melody({
    "link-resolver": {
      command: "pnpm --filter jobs run link-resolver",
      schedule: "17 */6 * * *",
      timezone: "America/Chicago",
      timeout: "2h",
      stop_timeout: "1m",
      working_dir: "apps/jobs",
      environment: { BATCH: "100" },
      env_file: ".env.jobs",
    },
  });
  expect(plan(config).jobs).toEqual([
    {
      name: "link-resolver",
      command: "pnpm --filter jobs run link-resolver",
      workingDir: "apps/jobs",
      env: { NODE_ENV: "production", BATCH: "100" },
      envFiles: [
        { path: "/rig/env/melody/all.env", required: false },
        { path: "/rig/env/melody/stable.env", required: false },
        { path: "/srv/melody/.env.jobs", required: true },
        { path: "/rig/env/melody/link-resolver/all.env", required: false },
        { path: "/rig/env/melody/link-resolver/stable.env", required: false },
      ],
      schedule: "17 */6 * * *",
      timeZone: "America/Chicago",
      timeout: 7200,
      stopTimeout: 60,
    },
  ]);
  // Every Target plans it, so rig run reaches it there, but the schedule runs it only where its targets say.
  for (const role of ["working", "preview"] as const)
    expect(plan(config, role).jobs).toEqual([
      expect.objectContaining({ name: "link-resolver", scheduled: false }),
    ]);
  // A plan with no job records no `jobs` key.
  expect(
    plan({ name: "pantry", services: { web: { command: "serve" } } }),
  ).not.toHaveProperty("jobs");
});

test("targets opts a job into other Targets, and a job without timezone records none, so the Host's zone applies", () => {
  const config = melody({
    palettes: {
      command: "palettes",
      schedule: "43 4 * * *",
      targets: ["working", "preview"],
    },
  });
  for (const role of ["working", "preview"] as const) {
    expect(plan(config, role).jobs).toEqual([
      expect.objectContaining({ name: "palettes", schedule: "43 4 * * *" }),
    ]);
    expect(plan(config, role).jobs![0]).not.toHaveProperty("scheduled");
  }
  expect(plan(config, "working").jobs![0]).not.toHaveProperty("timeZone");
  expect(plan(config, "stable").jobs).toEqual([
    expect.objectContaining({ name: "palettes", scheduled: false }),
  ]);
});

test("a job has the Target's references: Service ports, a Service's data directory, and its own", () => {
  const jobs = plan(
    melody({
      "mb-mirror": {
        command:
          "mirror --db 127.0.0.1:${services.postgres.port} --search ${services.typesense.ports.api} --work ${rig.data}",
        schedule: "0 7 * * 3,6",
        environment: {
          COVER_CACHE: "${services.api.data}/covers",
          TARGET: "${rig.target}",
          URL: "http://127.0.0.1:${services.api.port}",
        },
      },
    }),
  ).jobs!;
  expect(jobs[0]!.command).toBe(
    "mirror --db 127.0.0.1:5432 --search 8108 --work /rig/data/mb-mirror",
  );
  expect(jobs[0]!.env).toMatchObject({
    COVER_CACHE: "/rig/data/api/covers",
    TARGET: "stable",
    URL: "http://127.0.0.1:4000",
  });
  // A Service shares its directory by the same reference.
  const service = plan({
    name: "pantry",
    services: {
      api: { command: "serve", ports: { http: 4000 } },
      worker: {
        command: "work",
        environment: { CACHE: "${services.api.data}" },
      },
    },
  }).components.find((component) => component.name === "worker");
  expect(service).toMatchObject({ env: { CACHE: "/rig/data/api" } });
});

test("a job's own short port references, unknown Services and Project builds reaching a Service's data are refused", () => {
  expect(
    refusal(melody({ x: { command: "run ${port}", schedule: "* * * * *" } })),
  ).toContain("has no Service");
  expect(
    refusal(
      melody({
        x: { command: "run ${services.nope.data}", schedule: "* * * * *" },
      }),
    ),
  ).toContain("'nope' is not a declared Service");
  expect(
    refusal({
      name: "pantry",
      build: "cp -r ${services.api.data} dist",
      services: { api: { command: "serve" } },
    }),
  ).toContain("cannot use a Service's data");
  // rig.data still has no owner at the Project level.
  expect(
    refusal({
      name: "pantry",
      environment: { DATA: "${rig.data}" },
      services: { api: { command: "serve" } },
    }),
  ).toContain("has no Service or job");
});

test("a job's settings are validated with guidance", () => {
  const job = (settings: Record<string, unknown>) =>
    refusal(
      melody({
        nightly: { command: "run", schedule: "0 3 * * *", ...settings },
      }),
    );
  expect(job({ schedule: "0 3 * *" })).toContain(
    "jobs.nightly.schedule: must be five cron fields",
  );
  expect(job({ timezone: "Central" })).toContain(
    "jobs.nightly.timezone: must be an IANA time zone name",
  );
  expect(job({ timeout: "200h" })).toContain(
    "jobs.nightly.timeout: must be a duration from 1s to 168h",
  );
  expect(job({ targets: [] })).toContain("jobs.nightly.targets");
  expect(job({ targets: ["stable", "stable"] })).toContain(
    "must not name a Target twice",
  );
  expect(job({ targets: ["live"] })).toContain("jobs.nightly.targets.0");
  expect(job({ working_dir: "../elsewhere" })).toContain(
    "must be a directory inside the workspace",
  );
  expect(job({ command: "serve --host 0.0.0.0" })).toContain("localhost");
  expect(job({ run: "old" })).toContain("`run` is now `command`");
  expect(job({ restart: "always" })).toContain('has no field named "restart"');
  expect(
    refusal(melody({ api: { command: "run", schedule: "0 3 * * *" } })),
  ).toContain("jobs.api: A job cannot share its name with a Service.");
});

test("a Project of jobs alone is valid", () => {
  expect(
    refusal({
      name: "batch",
      jobs: { nightly: { command: "run", schedule: "0 3 * * *" } },
    }),
  ).toBeUndefined();
  expect(refusal({ name: "batch" })).toContain(
    "A Project needs at least one Service, Tool or job.",
  );
});

test("the editor schema documents every job setting", () => {
  const job = (configJsonSchemas()["rig.schema.json"] as any).properties.jobs
    .additionalProperties;
  expect(Object.keys(job.properties)).toEqual([
    "command",
    "schedule",
    "timezone",
    "timeout",
    "stop_timeout",
    "working_dir",
    "environment",
    "env_file",
    "targets",
  ]);
  for (const [name, setting] of Object.entries(job.properties))
    expect([
      name,
      (setting as { description?: string }).description?.length ?? 0,
    ]).toEqual([name, expect.any(Number)]);
  expect(job.properties.timezone.description).toContain("Mac's own time zone");
  expect(job.properties.timezone.description).toContain("spring change");
  expect(job.properties.targets.description).toContain("Default: [stable]");
  expect(job.required).toEqual(["command", "schedule"]);
});
