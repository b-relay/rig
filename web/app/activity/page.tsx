import type { Metadata } from "next";
import Link from "@/components/link";
import { SearchX } from "lucide-react";
import { attempt, type Outcome } from "@/lib/outcome";
import type { ActivityResult } from "@/lib/types";
import { read } from "@/server/daemon";
import { pagePulse } from "@/server/pulse";
import {
  ActivityTimeline,
  OperationRecord,
} from "@/components/activity-timeline";
import { Empty, Failure, PageHeader } from "@/components/bits";

export const metadata: Metadata = { title: "Activity" };
/** Every Operation on this Host, or one of them in full when `?operation=` names it. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ operation?: string }>;
}) {
  const { operation } = await searchParams;
  // Every Operation is the page's pulse reading, which the sidebar reads too; one Operation is a read of its own.
  const activity: Outcome<ActivityResult> = operation
    ? await attempt(read({ action: "activity", operation }))
    : (await pagePulse()).readings.activity;
  const operations = activity.ok ? activity.value.operations : [];
  return (
    <>
      <PageHeader
        title="Activity"
        eyebrow={
          operation ? (
            <Link href="/activity" className="text-muted-foreground">
              All activity
            </Link>
          ) : undefined
        }
        description={
          operation
            ? "One Operation, by its id."
            : "What rigd has done on this Mac, newest first: deploys, starts and stops, crashes, registrations and secret changes."
        }
      />
      {!activity.ok ? <Failure failure={activity.failure} /> : null}
      {operation && activity.ok ? (
        operations.length === 0 ? (
          <Empty icon={SearchX}>
            rigd has no record of an Operation with that id.
          </Empty>
        ) : (
          operations.map((each) => (
            <OperationRecord key={each.id} operation={each} />
          ))
        )
      ) : activity.ok ? (
        <ActivityTimeline operations={operations} now={Date.now()} />
      ) : null}
    </>
  );
}
