import type { Metadata } from "next";
import { attempt } from "@/lib/outcome";
import type { ActivityResult } from "@/lib/types";
import { read } from "@/server/daemon";
import { ActivityTable, OperationRecord } from "@/components/activity-table";
import { Empty, Failure } from "@/components/bits";

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
      <div>
        <h1 className="title text-2xl">Activity</h1>
        <p className="text-sm text-muted-foreground">
          {operation
            ? "One Operation, by its id."
            : "What rigd has done, newest first."}
        </p>
      </div>
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
