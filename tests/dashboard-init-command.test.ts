import { expect, test } from "bun:test";
import { commandSchema } from "../src/daemon/protocol";
import { initCommand, type InitFields } from "../web/lib/init-command";

const fields: InitFields = {
  repoPath: "/Users/you/code/app",
  project: "app",
  productionBranch: "main",
  domain: "app.example.com",
  createGit: true,
  kind: "service",
  name: "web",
  serviceCommand: "bun run start",
  port: "3000",
  healthcheck: "http://127.0.0.1:3000/health",
  bin: "",
  build: "",
};

test("the new-project form's init command is one rigd accepts, its health check under healthcheck", () => {
  const command = initCommand(fields);
  expect(command).toMatchObject({
    service: { healthcheck: "http://127.0.0.1:3000/health", port: 3000 },
  });
  expect(commandSchema.safeParse(command).success).toBe(true);
  // An empty field is left out rather than sent empty, and a Tool sends no Service settings.
  const tool = initCommand({
    ...fields,
    kind: "tool",
    bin: "dist/app",
    healthcheck: "",
  });
  expect(tool).toMatchObject({ tool: { name: "web", bin: "dist/app" } });
  expect(tool).not.toHaveProperty("service");
  expect(commandSchema.safeParse(tool).success).toBe(true);
  // An existing rig.yaml decides its own settings, so none are sent for it.
  expect(initCommand({ ...fields, kind: "existing" })).toEqual({
    action: "init",
    repoPath: "/Users/you/code/app",
    project: "app",
    createGit: true,
  });
});
