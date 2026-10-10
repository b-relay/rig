import type { Metadata } from "next";
import { attempt } from "@/lib/outcome";
import type { ActivityResult } from "@/lib/types";
import { read } from "@/server/daemon";
import { ActivityTable, OperationRecord } from "@/components/activity-table";
import { Empty, Failure, PageHeader } from "@/components/bits";

export const metadata: Metadata = { title: "Activity" };
/** Every Operation on this Host, or one of them in full when `?operation=` names it. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ operation?: string }>;
}) {
  const { operation } = await searchParams;
  const activity = await attempt(
    read({ action: "activity", ...(operation ? { operation } : {}) }),
  );
  const operations = activity.ok
    ? (activity.value as ActivityResult).operations
    : [];
  return (
    <>
      <PageHeader
        title="Activity"
        description={
          operation
            ? "One Operation, by its id."
            : "What rigd has done on this Mac, newest first: deploys, starts and stops, crashes, registrations and secret changes."
        }
      />
      {!activity.ok ? <Failure failure={activity.failure} /> : null}
      {operation && activity.ok ? (
        operations.length === 0 ? (
          <Empty>rigd has no record of an Operation with that id.</Empty>
        ) : (
          operations.map((each) => (
            <OperationRecord key={each.id} operation={each} />
          ))
        )
      ) : activity.ok ? (
        <ActivityTable operations={operations} />
      ) : null}
    </>
  );
}
