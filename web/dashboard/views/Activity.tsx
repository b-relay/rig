import { href, useApi, useRead } from "../hooks";
import { Empty, Failure, Panel, State, when } from "../ui";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function ActivityView({
  project,
  operation,
}: {
  project?: string;
  operation?: string;
}) {
  const api = useApi();
  const activity = useRead(
    (signal) =>
      api.command(
        {
          action: "activity",
          ...(project ? { project } : {}),
          ...(operation ? { operation } : {}),
        },
        signal,
      ),
    `activity:${project ?? ""}:${operation ?? ""}`,
    3000,
  );
  const rows = [...(activity.data?.operations ?? [])].reverse();
  return (
    <Panel
      title={operation ? `Operation ${operation}` : "Activity"}
      actions={
        operation ? (
          <Button asChild variant="outline" size="sm">
            <a href={href("activity")}>All activity</a>
          </Button>
        ) : null
      }
    >
      <Failure error={activity.error} />
      {activity.data?.operations.length === 0 ? (
        <Empty>Nothing recorded.</Empty>
      ) : null}
      {rows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              {project ? null : <TableHead>Project</TableHead>}
              <TableHead>Target</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead>Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((entry, index) => (
              <TableRow key={`${entry.id}:${index}`}>
                <TableCell className="whitespace-nowrap">
                  <a href={href("activity", entry.id)}>
                    {when(entry.occurredAt)}
                  </a>
                </TableCell>
                <TableCell>{entry.action}</TableCell>
                {project ? null : <TableCell>{entry.project}</TableCell>}
                <TableCell>{entry.target}</TableCell>
                <TableCell>
                  <State value={entry.outcome} />
                </TableCell>
                <TableCell className="max-w-md whitespace-normal">
                  {entry.message}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </Panel>
  );
}
