import Link from "next/link";
import type { ActivityResult } from "@/lib/types";
import { when } from "@/lib/present";
import { Empty, State } from "./bits";

type Operation = ActivityResult["operations"][number];
const HEAD =
  "px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap";
const CELL = "px-3 py-2 align-top";
/** Operations newest first; each links to its own record. */
export function ActivityTable({
  operations,
  showProject = true,
}: {
  operations: readonly Operation[];
  showProject?: boolean;
}) {
  if (operations.length === 0) return <Empty>Nothing has happened yet.</Empty>;
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0 sm:rounded-md sm:border sm:border-rule sm:bg-sheet">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="border-b border-rule">
          <tr>
            <th className={HEAD}>When</th>
            <th className={HEAD}>Action</th>
            {showProject ? <th className={HEAD}>Project</th> : null}
            <th className={HEAD}>Target</th>
            <th className={HEAD}>Outcome</th>
            <th className={HEAD}>Message</th>
          </tr>
        </thead>
        <tbody className="ruled">
          {[...operations].reverse().map((operation) => (
            <tr key={operation.id}>
              <td className={`${CELL} whitespace-nowrap`}>
                <Link
                  href={`/activity?operation=${encodeURIComponent(operation.id)}`}
                  className="text-ink"
                >
                  {when(operation.occurredAt)}
                </Link>
              </td>
              <td className={CELL}>{operation.action}</td>
              {showProject ? (
                <td className={CELL}>
                  {operation.project ? (
                    <Link
                      href={`/projects/${encodeURIComponent(operation.project)}`}
                    >
                      {operation.project}
                    </Link>
                  ) : null}
                </td>
              ) : null}
              <td className={CELL}>{operation.target}</td>
              <td className={CELL}>
                <State value={operation.outcome} />
              </td>
              <td className={`${CELL} max-w-md text-muted-foreground`}>
                {operation.message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
/** One Operation's full record, when it was asked for by id. */
export function OperationRecord({ operation }: { operation: Operation }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-md border border-rule bg-sheet p-4 text-sm">
      <dt className="text-muted-foreground">Operation</dt>
      <dd className="font-mono text-xs break-all">{operation.id}</dd>
      <dt className="text-muted-foreground">Action</dt>
      <dd>{operation.action}</dd>
      {operation.project ? (
        <>
          <dt className="text-muted-foreground">Project</dt>
          <dd>
            <Link href={`/projects/${encodeURIComponent(operation.project)}`}>
              {operation.project}
            </Link>
          </dd>
        </>
      ) : null}
      {operation.target ? (
        <>
          <dt className="text-muted-foreground">Target</dt>
          <dd>{operation.target}</dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Outcome</dt>
      <dd>
        <State value={operation.outcome} />
      </dd>
      <dt className="text-muted-foreground">When</dt>
      <dd>{when(operation.occurredAt)}</dd>
      {operation.message ? (
        <>
          <dt className="text-muted-foreground">Message</dt>
          <dd className="whitespace-pre-wrap">{operation.message}</dd>
        </>
      ) : null}
    </dl>
  );
}
