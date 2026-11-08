import { completedNotice } from "@/lib/target-work";
import { attempt } from "@/lib/outcome";
import { read } from "@/server/daemon";
import { Notice } from "./bits";

/** What a command that removed its own page did, on the page it landed on: `?operation=` names the Operation, and only what
 * Activity recorded of it is said. `project` is the Project whose page it is. */
export async function CompletedOperation({
  operation,
  project,
}: {
  operation: string | string[] | undefined;
  project?: string;
}) {
  if (typeof operation !== "string" || !operation) return null;
  const activity = await attempt(read({ action: "activity", operation }));
  const notice =
    activity.ok &&
    completedNotice(activity.value.operations, operation, project);
  if (!notice) return null;
  return (
    <Notice tone={notice.warnings ? "warn" : "good"}>
      <p>
        {notice.text}{" "}
        <a
          href={`/activity?operation=${encodeURIComponent(notice.operationId)}`}
          className="text-current underline"
        >
          operation
        </a>
      </p>
      {notice.warnings ? <p>{notice.warnings}</p> : null}
    </Notice>
  );
}
