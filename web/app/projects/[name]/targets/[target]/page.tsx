import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Empty, Facts, Mono, Panel } from "@/components/bits";
import { ServicesTable } from "@/components/services-table";
import { routeLines } from "@/lib/target-detail";
import { targetHref } from "@/lib/target";
import { target } from "@/server/target";

/** A Target at a glance: its Services, the paths its hostname serves, and what it runs from. */
export default async function TargetOverviewPage({
  params,
}: {
  params: Promise<{ name: string; target: string }>;
}) {
  const { project, target: report } = await target(params);
  const routes = routeLines(report);
  const href = targetHref(project.name, report.name);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel
        title="Services"
        description="State, cached health, ports and restarts, as rigd observed them just now."
        flush
        className="xl:col-span-2"
      >
        {report.components.length ? (
          <ServicesTable components={report.components} now={new Date()} />
        ) : (
          <p className="p-4">
            <Empty>This Target has no Services or Tools.</Empty>
          </p>
        )}
      </Panel>
      <Panel
        title="Routes"
        description={
          report.route
            ? "The paths Caddy serves under this Target's hostname."
            : "This Target has no hostname."
        }
        flush
      >
        {routes.length ? (
          <ul className="divide-y divide-rule/70 text-sm">
            {routes.map((route) => (
              <li
                key={route.prefix}
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
                    <Mono className="ml-1 break-normal text-muted-foreground">
                      127.0.0.1:{route.port}
                    </Mono>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {report.route
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
              ["Branch", report.branch ?? "unknown"],
              [
                "Commit",
                <Mono key="c" className="break-all">
                  {report.commit}
                </Mono>,
              ],
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
  );
}
