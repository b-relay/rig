"use client";

import type { ReactNode } from "react";
import type { Failure as ReadFailure } from "@/lib/outcome";
import type { ActivityResult } from "@/lib/types";
import {
  cardsOf,
  markersOf,
  type ChartReport,
  type ChartSeries,
  type UsageRange,
} from "@/lib/usage";
import { Failure } from "./bits";
import { CardGrid, CombinedCharts, Now, SeriesCard } from "./usage-cards";
import { useUsage } from "./usage-live";

type Operation = ActivityResult["operations"][number];
/** Components take the chart colours in turn, starting away from the Project's own blue. */
const PALETTE = [2, 4, 1, 5, 3].map((n) => `var(--chart-${n})`);

/** A Project's Monitor tab. The side column holds the Project's Doctor (one line on a phone while every check passes)
 * and its Activity. The main column stacks the chosen Target's Services and Jobs in one CPU and one memory chart, each
 * component's peak flagged where it happened; with `all`, it stacks the Targets instead. Then a card per Service and
 * Job of that Target, or per Target, each with its own charts. Live: it reads the Project's report again after every
 * sample; the side column stands even while that read fails. */
export function ProjectMonitor({
  project,
  initial,
  initialFailure,
  range,
  target,
  inventory,
  operations,
  now,
  doctor,
  activity,
}: {
  project: string;
  /** The report the page was rendered with; absent when that read failed, with `initialFailure` saying why. */
  initial?: ChartReport;
  initialFailure?: ReadFailure;
  range: UsageRange;
  /** The Target shown, by name, or `all`. */
  target: string;
  /** What gets a card even before it is sampled: the Target's Services and Jobs, or with `all` every Target. */
  inventory: readonly { readonly name: string; readonly kind?: string }[];
  operations: readonly Operation[];
  /** The page's render instant, for Activity's "ago". */
  now: number;
  doctor: ReactNode;
  activity: ReactNode;
}) {
  const { report, failure } = useUsage(
    initial,
    { project, target, range },
    initialFailure,
  );
  const series = report?.series ?? [];
  const total =
    target === "all"
      ? series.find((each) => each.series.scope === "project")
      : series.find(
          (each) =>
            each.series.scope === "target" && each.series.target === target,
        );
  const sampled =
    target === "all"
      ? series.filter((each) => each.series.scope === "target")
      : series.filter(
          (each) =>
            each.series.scope === "component" && each.series.target === target,
        );
  const cards = cardsOf(inventory, sampled, (each) =>
    target === "all"
      ? { name: each.series.target! }
      : { name: each.series.component!, kind: each.series.componentKind! },
  );
  // Each card keeps its colour as others start and stop sampling.
  const colorOf = (key: string) =>
    PALETTE[cards.findIndex((card) => card.key === key) % PALETTE.length]!;
  const relevant = operations.filter(
    (operation) => target === "all" || operation.target === target,
  );
  const main = report ? (
    <div className="flex min-w-0 flex-col gap-4">
      <CombinedCharts
        title={
          <>
            All of{" "}
            <span className="font-mono font-medium">
              {target === "all" ? "every Target" : target}
            </span>
          </>
        }
        aside={<Now series={total} />}
        {...(failure && { failure: failure.message })}
        parts={cards
          .filter((card) => card.series)
          .map((card) => ({
            series: card.series as ChartSeries,
            label: card.earlier ? `${card.name} (earlier)` : card.name,
            color: colorOf(card.key),
          }))}
        report={report}
        markers={markersOf(relevant, report)}
        empty="Nothing ran here in this range, so there is nothing to chart."
      />
      <CardGrid>
        {cards.map((card) => (
          <SeriesCard
            key={card.key}
            series={card.series}
            report={report}
            color={colorOf(card.key)}
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono">{card.name}</span>
                {card.earlier ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    earlier
                  </span>
                ) : null}
                {card.kind ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    {card.kind}
                  </span>
                ) : null}
              </span>
            }
            // Activity names Targets, not Services, so only a Target's card lists its own; a Service's is in the feed.
            activity={
              // An earlier incarnation's Activity cannot be told apart from the current one's by name.
              target === "all" && !card.earlier
                ? relevant.filter((operation) => operation.target === card.name)
                : []
            }
            markers={[]}
            now={now}
          />
        ))}
      </CardGrid>
    </div>
  ) : (
    // Read again every second: the charts appear as soon as a read succeeds.
    <Failure failure={failure} />
  );
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
        {doctor}
      </div>
      <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        {main}
      </div>
      <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-2">
        {activity}
      </div>
    </div>
  );
}
