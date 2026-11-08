import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ActivityTimeline,
  OperationRecord,
} from "../web/components/activity-timeline";
import { CONTENT_ID, SkipToContent } from "../web/components/bits";
import { ActivityFeed, DoctorList } from "../web/components/monitor-side";
import type { ActivityResult, DoctorReport } from "../web/lib/types";

/** What the dashboard's read-only cards say: nothing rigd recorded for an operator is dropped on the way to the page. */

type Operation = ActivityResult["operations"][number];
const run = (fields: Partial<Operation> = {}): Operation => ({
  id: "op-1",
  action: "run",
  outcome: "started",
  occurredAt: "2026-11-05T10:00:00.000Z",
  project: "probe",
  target: "working",
  ...fields,
});
const NOW = Date.parse("2026-11-05T12:00:00.000Z");

test("a failing Doctor check shows what it found, its hint and its reason; one with no reason reads as well", () => {
  const report: DoctorReport = {
    ok: false,
    checks: [
      {
        name: "rigd/diagnostics",
        ok: false,
        message:
          "Writing diagnostics failed 3 times between 09:00 and 09:05: ENOTDIR; later entries were lost.",
        reason: "diagnostics-failing",
        hint: "Make logs/rigd writable.",
      },
      { name: "rig.yaml", ok: false, message: "It does not parse." },
    ],
  };
  const page = renderToStaticMarkup(<DoctorList report={report} />);
  expect(page).toContain("failed 3 times between 09:00 and 09:05");
  expect(page).toContain("diagnostics-failing");
  expect(page).toContain("Make logs/rigd writable.");
  expect(page).toContain("It does not parse.");
});

test("two Job runs that started together are told apart by their recorded Component, before either ends", () => {
  const operations = [
    run({ id: "a", component: { kind: "job", name: "alpha" } }),
    run({ id: "b", component: { kind: "job", name: "beta" } }),
  ];
  const timeline = renderToStaticMarkup(
    <ActivityTimeline now={NOW} operations={operations} />,
  );
  expect(timeline).toContain("job alpha");
  expect(timeline).toContain("job beta");
  const feed = renderToStaticMarkup(
    <ActivityFeed showProject={false} now={NOW} operations={operations} />,
  );
  expect(feed).toContain("alpha");
  expect(feed).toContain("beta");
});

test("an Operation's full record names its recorded Component; a whole Target's has no such row", () => {
  const crash = renderToStaticMarkup(
    <OperationRecord
      operation={run({
        action: "restart",
        outcome: "failed",
        component: { kind: "service", name: "web" },
      })}
    />,
  );
  expect(crash).toContain("Component");
  expect(crash).toContain("service web");
  const whole = renderToStaticMarkup(
    <OperationRecord operation={run({ action: "up" })} />,
  );
  expect(whole).not.toContain("Component");
});

test("the skip link comes before the sidebar and names the main region, which can take focus", async () => {
  const link = renderToStaticMarkup(<SkipToContent />);
  expect(link).toContain(`href="#${CONTENT_ID}"`);
  expect(link).toContain("Skip to content");
  // Hidden until focused, so the first Tab shows it.
  expect(link).toContain("focus:not-sr-only");
  const layout = await Bun.file(
    `${import.meta.dir}/../web/app/layout.tsx`,
  ).text();
  expect(layout.indexOf("<SkipToContent />")).toBeLessThan(
    layout.indexOf("<Navigation"),
  );
  expect(layout).toMatch(/id=\{CONTENT_ID\}\s+tabIndex=\{-1\}/);
});
