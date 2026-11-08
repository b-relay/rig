import { expect, test } from "bun:test";
import {
  installedTools,
  rootCommits,
  supersededTools,
} from "../src/adapters/target-artifacts";
import type { PlanComponent, TargetPlan } from "../src/config/types";
import type { TargetRecord } from "../src/domain/runtime";

const tool = (name: string, extra: object = {}): PlanComponent => ({
  name,
  kind: "installed",
  entrypoint: `bin/${name}`,
  env: {},
  dependsOn: [],
  ...extra,
});
const service: PlanComponent = {
  name: "web",
  kind: "managed",
  command: "serve",
  readyTimeout: 1,
  env: {},
  dependsOn: [],
};
const plan = (components: PlanComponent[]): TargetPlan => ({
  project: "demo",
  target: "stable",
  workspacePath: "/ws",
  dataRoot: "/data",
  deploymentName: "stable",
  branchSlug: "stable",
  subdomain: "stable",
  providers: { processSupervisor: "rigd" },
  components,
  preparedComponents: [],
});
const record = (
  kind: TargetRecord["kind"],
  components: PlanComponent[],
): TargetRecord => ({
  id: kind,
  projectId: "p",
  name: kind,
  kind,
  desired: "running",
  createdAt: "now",
  updatedAt: "now",
  logRoot: "/logs",
  plan: plan(components),
});

test("a plan's Tools are its installed Components, in plan order", () => {
  expect(installedTools(plan([tool("a"), service, tool("b")]))).toEqual([
    tool("a"),
    tool("b"),
  ] as never);
  expect(installedTools(plan([service]))).toEqual([]);
});

test("a superseded Tool is one whose published path the candidate does not publish", () => {
  const previous = record("stable", [tool("a"), tool("b"), tool("c")]);
  const candidate = record("stable", [
    tool("a"),
    // Renamed onto b's path, so b is kept.
    tool("renamed", { installName: "b" }),
  ]);
  expect(
    supersededTools("/rig", previous, candidate).map((each) => each.name),
  ).toEqual(["c"]);
  // The working Target publishes under its own suffix, so none of the stable Target's paths is kept.
  expect(
    supersededTools("/rig", previous, record("working", [tool("a")])).map(
      (each) => each.name,
    ),
  ).toEqual(["a", "b", "c"]);
  expect(supersededTools("/rig", record("stable", []), candidate)).toEqual([]);
});

test("a repository is known by its root commits, sorted and joined; anything else git printed is ignored", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(64);
  expect(rootCommits(`${b}\n  ${a}  \nwarning: noise\n\n`)).toEqual({
    kind: "known",
    roots: `${a},${b}`,
  });
  expect(rootCommits("")).toEqual({ kind: "unknown" });
  expect(rootCommits("A".repeat(40))).toEqual({ kind: "unknown" });
  expect(rootCommits("a".repeat(39))).toEqual({ kind: "unknown" });
});
