import Link from "next/link";
import { ArrowRight, Boxes } from "lucide-react";
import { Empty, Facts, Mono, Panel } from "@/components/bits";
import { ServiceCards } from "@/components/service-cards";
import { deploymentRows, formatDuration } from "@/lib/deployments";
import { ago, when } from "@/lib/present";
import { routeLines } from "@/lib/target-detail";
import { deploymentHistory } from "@/server/deployments";
import { targetHostnames, targetHref } from "@/lib/target";
import { target } from "@/server/target";

/** A Target at a glance: its Services, the paths each of its hostnames serves, and what it runs from. */
export default async function TargetOverviewPage({
  params,
}: {
  params: Promise<{ name: string; target: string }>;
}) {
  const { project, target: report } = await target(params);
  const routes = routeLines(report);
  const hostnames = targetHostnames(report);
  // The deploy that put the running Commit in place, when rigd recorded it.
  const history =
    report.kind === "working"
      ? undefined
      : await deploymentHistory(project.name);
  const current = history?.ok
    ? deploymentRows(
        history.value.deployments.filter(
          (deploy) => deploy.target === report.name,
        ),
        [report],
      ).find((row) => row.current)
    : undefined;
  const href = targetHref(project.name, report.name);
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">
          Services{" "}
          <span className="font-normal text-muted-foreground">
            as rigd observed them just now
          </span>
        </h2>
        {report.components.length ? (
          <ServiceCards components={report.components} now={new Date()} />
        ) : (
          <Empty icon={Boxes}>This Target has no Services or Tools.</Empty>
        )}
      </section>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel
          title="Routes"
          description={
            hostnames.length
              ? "The paths Caddy serves under each of this Target's hostnames."
              : "This Target has no hostname."
          }
          flush
        >
          {routes.length ? (
            <ul className="divide-y text-sm">
              {routes.map((route) => (
                <li
                  key={route.url}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
                >
                  <a
                    href={route.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate"
                  >
                    {route.url}
                  </a>
                  <ArrowRight
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                  <span>
                    {route.service}
                    {route.port !== undefined ? (
                      <Mono className="ml-1.5 break-normal text-muted-foreground">
                        127.0.0.1:{route.port}
                      </Mono>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              {hostnames.length
                ? "No Service is routed yet."
                : report.kind === "working"
                  ? "The working Target is reached on its loopback ports."
                  : "Set domain in rig.yaml to publish it."}
            </p>
          )}
        </Panel>
        <Panel
          title={report.kind === "working" ? "Source" : "Current deployment"}
          actions={
            report.kind === "working" ? null : (
              <Link href={`${href}/deployments`} className="text-xs">
                History
              </Link>
            )
          }
        >
          {report.kind === "working" ? (
            <p className="text-sm text-muted-foreground">
              The working Target runs the checkout at{" "}
              <Mono>{project.repoPath}</Mono> as it is on disk, planned from its
              current rig.yaml when it starts.
            </p>
          ) : report.commit ? (
            <Facts
              items={[
                ["Branch", <Mono key="b">{report.branch ?? "unknown"}</Mono>],
                [
                  "Commit",
                  <Mono key="c" className="break-all">
                    {report.commit}
                  </Mono>,
                ],
                current
                  ? [
                      "Deployed",
                      <span key="w" title={when(current.finishedAt)}>
                        {ago(current.finishedAt, Date.now())}, in{" "}
                        {formatDuration(current.durationMs)}
                      </span>,
                    ]
                  : undefined,
                report.deploymentIncomplete
                  ? [
                      "Deploy",
                      <span key="d" className="text-warn">
                        did not complete
                      </span>,
                    ]
                  : undefined,
                report.transitionPending
                  ? [
                      "Transition",
                      <span key="t" className="text-warn">
                        unresolved
                      </span>,
                    ]
                  : undefined,
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Not deployed yet.{" "}
              <Link href={`${href}/deployments`}>Deploy it</Link>.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
