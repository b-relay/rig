import { Play, RotateCw, Square, Trash2 } from "lucide-react";
import type {
  OperationResult,
  ProjectStatusReport,
  TargetReport,
} from "../types";
import { href, useAct, useApi } from "../hooks";
import { targetKey, targetSelector } from "../target";
import {
  Confirm,
  Empty,
  Facts,
  Failure,
  Notice,
  Panel,
  State,
  short,
} from "../ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function OperationNotice({
  result,
}: {
  result: OperationResult | undefined;
}) {
  if (!result) return null;
  return (
    <Notice tone="good">
      <p>
        {[result.project, result.target, result.outcome]
          .filter(Boolean)
          .join(" ")}
        {result.commit ? `, ${short(result.commit)}` : ""}{" "}
        <a href={href("activity", result.operationId)}>operation</a>
      </p>
      {result.warnings?.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </Notice>
  );
}
export function Targets({
  project,
  status,
  reload,
}: {
  project: string;
  status: ProjectStatusReport | undefined;
  reload(): void;
}) {
  const api = useApi();
  const start = useAct<OperationResult>();
  const hasWorkingCopy = status?.targets.some((each) => each.kind === "local");
  return (
    <>
      {status && !hasWorkingCopy ? (
        <Panel
          title="Working copy"
          actions={
            <Button
              size="sm"
              disabled={start.busy}
              onClick={() =>
                void start
                  .run(() => api.command({ action: "up", project }))
                  .then(reload)
              }
            >
              <Play />
              {start.busy ? "Starting…" : "Start Working copy"}
            </Button>
          }
        >
          <Empty>
            Not started yet. It runs the files on disk, without a deploy.
            {status.targets.length === 0
              ? " To run a Branch instead, use the Deploy tab."
              : ""}
          </Empty>
          <Failure error={start.error} />
          <OperationNotice result={start.result} />
        </Panel>
      ) : null}
      {status?.targets.map((target) => (
        <TargetPanel
          key={targetKey(target)}
          project={project}
          target={target}
          reload={reload}
        />
      ))}
    </>
  );
}
const KIND = { local: "Working copy", live: "Stable", preview: "Preview" };
function TargetPanel({
  project,
  target,
  reload,
}: {
  project: string;
  target: TargetReport;
  reload(): void;
}) {
  const api = useApi();
  const act = useAct<OperationResult>();
  // Stopping the Target that serves this page cuts the request off; rigd still finishes it.
  const servesThisPage =
    typeof target.route === "string" &&
    target.route.replace(/^https?:\/\//, "").split("/")[0] ===
      window.location.host;
  const send = (action: "up" | "down" | "restart" | "destroy") =>
    void act
      .run(() => api.command({ action, project, ...targetSelector(target) }))
      .then(reload);
  const servesNote =
    "This Target serves the dashboard you are using. The page loses its connection while rigd finishes; check Activity afterwards.";
  return (
    <Panel
      title={
        <>
          {target.name}
          <Badge variant="secondary">{KIND[target.kind]}</Badge>
          <State value={target.state} />
        </>
      }
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={act.busy}
            onClick={() => send("up")}
          >
            <Play /> Up
          </Button>
          <Confirm
            when={servesThisPage}
            title={`Restart ${target.name}?`}
            description={servesNote}
            confirmLabel="Restart"
            onConfirm={() => send("restart")}
          >
            <Button variant="outline" size="sm" disabled={act.busy}>
              <RotateCw /> Restart
            </Button>
          </Confirm>
          <Confirm
            when={servesThisPage}
            title={`Stop ${target.name}?`}
            description={servesNote}
            confirmLabel="Down"
            onConfirm={() => send("down")}
          >
            <Button variant="outline" size="sm" disabled={act.busy}>
              <Square /> Down
            </Button>
          </Confirm>
          {target.kind === "preview" ? (
            <Confirm
              title={`Destroy Preview ${target.name}?`}
              description={`Its data, logs, and source history are removed.${servesThisPage ? ` ${servesNote}` : ""}`}
              confirmLabel="Destroy"
              destructive
              onConfirm={() => send("destroy")}
            >
              <Button variant="destructive" size="sm" disabled={act.busy}>
                <Trash2 /> Destroy
              </Button>
            </Confirm>
          ) : null}
        </>
      }
    >
      {servesThisPage ? (
        <p className="text-xs text-muted-foreground">
          This Target serves the dashboard you are using.
        </p>
      ) : null}
      <Facts
        items={[
          target.branch ? (["Branch", target.branch] as const) : undefined,
          target.commit
            ? (["Commit", <code key="c">{short(target.commit)}</code>] as const)
            : undefined,
          target.route
            ? ([
                "Route",
                <span key="r" className="flex flex-wrap items-center gap-2">
                  <a href={target.route} target="_blank" rel="noreferrer">
                    {target.route}
                  </a>
                  {target.routePublished === false ? (
                    <State value="unknown" />
                  ) : null}
                </span>,
              ] as const)
            : undefined,
        ]}
      />
      {target.routePublished === false ? (
        <Notice tone="warn">The route is not published by Caddy.</Notice>
      ) : null}
      {target.deploymentIncomplete ? (
        <Notice tone="warn">The last deploy did not complete.</Notice>
      ) : null}
      {target.transitionPending ? (
        <Notice tone="warn">A deployment transition is unresolved.</Notice>
      ) : null}
      {target.destructionPending ? (
        <Notice tone="warn">Destruction did not finish; retry Destroy.</Notice>
      ) : null}
      {act.busy ? <Notice>Working…</Notice> : null}
      <Failure error={act.error} />
      <OperationNotice result={act.result} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Component</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Port</TableHead>
            <TableHead>PID</TableHead>
            <TableHead>Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {target.components.map((component) => (
            <TableRow key={component.name}>
              <TableCell className="font-medium">{component.name}</TableCell>
              <TableCell>{component.kind}</TableCell>
              <TableCell>
                <State value={component.state} />
              </TableCell>
              <TableCell>{component.port}</TableCell>
              <TableCell>{component.pid}</TableCell>
              <TableCell className="whitespace-normal text-muted-foreground">
                {[
                  component.reason,
                  component.exit ? `exit: ${component.exit}` : undefined,
                  component.exitCode === undefined
                    ? undefined
                    : `code ${component.exitCode}`,
                  component.signal,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
