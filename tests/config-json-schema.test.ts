import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  configJsonSchemas,
  renderJsonSchema,
  resolveTargetPlan,
} from "../src/config/index.js";

const REPO = join(import.meta.dir, "..");
const schemas = configJsonSchemas();
type Json = Record<string, any>;
const project = schemas["rig.schema.json"] as Json;
const host = schemas["host-config.schema.json"] as Json;
const service = project.properties.services.additionalProperties as Json;
const tool = project.properties.tools.additionalProperties as Json;

test.each(Object.keys(schemas) as (keyof typeof schemas)[])(
  "the committed schemas/%s is the schema the code generates",
  async (file) => {
    const committed = await readFile(join(REPO, "schemas", file), "utf8").catch(
      () => "",
    );
    if (committed !== renderJsonSchema(schemas[file]))
      throw new Error(
        `schemas/${file} is out of date with src/config/schema.ts. Run \`bun run schema\` and commit the result.`,
      );
  },
);

test("the Project schema names its draft, identity and the public top-level settings", () => {
  expect(project.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  expect(project.$id).toBe(
    "https://raw.githubusercontent.com/b-relay/rig/main/schemas/rig.schema.json",
  );
  expect(project.title).toBe("Rig Project config (rig.yaml)");
  expect(Object.keys(project.properties)).toEqual(
    expect.arrayContaining(["services", "tools", "proxy", "targets"]),
  );
  // A rig.yaml in the current format declares it; one without format is rig/v1 (rig-v1.schema.json).
  expect(project.required).toEqual(["format", "name"]);
  expect(project.properties.format.const).toBe("rig/v2");
  expect(project.additionalProperties).toBe(false);
  expect(project.properties.supervisor.enum).toEqual(["rigd", "launchd"]);
  expect(service.properties.restart.enum).toEqual([
    "always",
    "on-failure",
    "no",
  ]);
  expect(host.title).toBe("Rig Host config (config.yaml)");
  expect(host.properties.deploy.properties.previews.properties).toMatchObject({
    max: { default: 25 },
    replace_policy: { default: "oldest", enum: ["oldest", "reject"] },
  });
});

test("the deprecated rig/v1 format keeps a schema of its own, with ready and ready_timeout and the same defaults", () => {
  const v1 = schemas["rig-v1.schema.json"] as Json;
  const v1Service = v1.properties.services.additionalProperties as Json;
  expect(v1.$id).toBe(
    "https://raw.githubusercontent.com/b-relay/rig/main/schemas/rig-v1.schema.json",
  );
  expect(v1.deprecated).toBe(true);
  expect(v1.required).toEqual(["name"]);
  expect(v1.properties.format.const).toBe("rig/v1");
  expect(v1Service.properties.ready_timeout.default).toBe(
    service.properties.health.properties.start_timeout.default,
  );
  expect(v1Service.properties.ready.description).toContain("health.check");
  expect(v1Service.properties).not.toHaveProperty("health");
  expect(service.properties).not.toHaveProperty("ready");
  expect(project.description).toContain("rig-v1.schema.json");
});

test("env is documented as a map of names to strings, not as an untyped value", () => {
  for (const env of [project.properties.env, service.properties.env]) {
    expect(env).toMatchObject({
      type: "object",
      propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      additionalProperties: { type: "string" },
    });
    expect(env.description).toContain("never put secrets here");
  }
});

test("every default the schema shows is the value planning applies when the setting is absent", () => {
  const plan = resolveTargetPlan(
    {
      config: {
        name: "app",
        build: "make",
        services: { web: { run: "serve", build: "make web" } },
        tools: { report: { bin: "bin/report", build: "make report" } },
      },
      target: "live",
      workspacePath: "/work",
      dataRoot: "/data",
    },
    { operatorHome: "/home/operator", envRoot: "/rig/env" },
  );
  const web = plan.components.find((component) => component.name === "web")!;
  const seconds = (duration: string) => {
    const [, amount, unit] = /^(\d+)(s|m|h)$/.exec(duration)!;
    return Number(amount) * { s: 1, m: 60, h: 3600 }[unit as "s" | "m" | "h"];
  };
  expect(project.properties.supervisor.default).toBe(
    plan.providers.processSupervisor,
  );
  expect(
    plan
      .builds!.map((unit) => unit.timeout)
      .every(
        (timeout) =>
          timeout === seconds(project.properties.build_timeout.default),
      ),
  ).toBe(true);
  expect(web).toMatchObject({
    readyTimeout: seconds(
      service.properties.health.properties.start_timeout.default,
    ),
    restart: service.properties.restart.default,
  });
  const names = project.properties.targets.properties;
  expect(names.stable.properties.name.default).toBe(plan.deploymentName);
  expect(names.working.properties.name.default).toBe("local");
  // Settings that inherit from another setting have no fixed default to show.
  expect(service.properties.build_timeout.default).toBeUndefined();
  expect(tool.properties.build_timeout.default).toBeUndefined();
  expect(
    names.working.properties.services.additionalProperties.properties.restart
      .default,
  ).toBeUndefined();
});

test("each field that takes references lists the references valid there", () => {
  const shared = [
    "${env.NAME}",
    "${services.<service>.ports.<port>}",
    "${rig.target}",
    "${rig.workspace}",
    "${rig.host}",
    "${rig.url}",
    "$${VAR}",
  ];
  const inService = [
    service.properties.run,
    service.properties.build,
    service.properties.health.properties.check,
    service.properties.env.additionalProperties,
    service.properties.env_file,
  ];
  const inProject = [
    project.properties.build,
    project.properties.env.additionalProperties,
    project.properties.env_file,
    tool.properties.build,
    tool.properties.bin,
    project.properties.targets.properties.preview.properties.build,
  ];
  for (const field of [...inService, ...inProject])
    for (const reference of shared)
      expect(field.description).toContain(reference);
  for (const field of inService)
    expect(field.description).toContain("${rig.data}");
  // rig.data belongs to one Service, so a Project-level field must not offer it as available.
  for (const field of inProject)
    expect(field.description).not.toMatch(/, \$\{rig\.data\}/);
  for (const domain of [
    project.properties.domain,
    project.properties.targets.properties.preview.properties.domain,
  ]) {
    expect(domain.description).toContain("${rig.target} is the only reference");
    expect(domain.description).not.toContain("${rig.url}");
  }
  const upstream = project.properties.proxy.additionalProperties;
  expect(upstream.description).toContain(
    "exactly one ${services.<service>.ports.<port>}",
  );
  expect(upstream.pattern).toBeString();
});
