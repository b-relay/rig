import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, FileCode2, TriangleAlert } from "lucide-react";
import type { ProjectEntry } from "@/lib/board-rows";
import { customCaddyFile, proxyRoutes } from "@/lib/proxy";
import { projectHref, targetHref } from "@/lib/target";
import { projectList, projectStatus } from "@/server/status";
import {
  Empty,
  Failure,
  KindTag,
  Mono,
  PageHeader,
  Panel,
  Stat,
  StatePill,
} from "@/components/bits";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Proxy" };
const HEAD =
  "h-8 px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";
/** Every hostname and path Caddy serves for this Host, the Target and Service each reaches, and the
 * operator's own Caddy file once Rig runs its own Caddy. */
export default async function ProxyPage() {
  const list = await projectList();
  if (!list.ok)
    return (
      <>
        <PageHeader title="Proxy" />
        <Failure failure={list.failure} />
      </>
    );
  const entries: ProjectEntry[] = await Promise.all(
    list.value.projects.map(async (project) => ({
      project,
      ...(project.missing ? {} : { status: await projectStatus(project.name) }),
    })),
  );
  const routes = proxyRoutes(entries);
  const hosts = new Set(routes.map((route) => route.host));
  const unpublished = routes.filter((route) => !route.published).length;
  const custom = await customCaddyFile();
  return (
    <>
      <PageHeader
        title="Proxy"
        description="Every hostname Caddy serves for this Mac, and the loopback Service each path reaches."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Hostnames" value={hosts.size} />
        <Stat label="Routes" value={routes.length} />
        <Stat
          label="Not published"
          value={unpublished}
          tone={unpublished ? "warn" : undefined}
        />
      </div>
      {unpublished ? (
        <p className="flex gap-2 text-sm text-warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            The Host&apos;s Caddy does not load Rig&apos;s route file, so some
            routes are inert. <Link href="/doctor">Doctor</Link> names the fix.
          </span>
        </p>
      ) : null}
      <Panel title="Hostnames" flush>
        {routes.length === 0 ? (
          <p className="px-4 py-6">
            <Empty>
              No Target has a hostname. Set <code>domain</code> in a
              Project&apos;s rig.yaml to publish one.
            </Empty>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[52rem] text-[13px]">
              <TableHeader>
                <TableRow className="border-rule hover:bg-transparent">
                  <TableHead className={HEAD}>Hostname</TableHead>
                  <TableHead className={HEAD}>Upstream</TableHead>
                  <TableHead className={HEAD}>Target</TableHead>
                  <TableHead className={HEAD}>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routes.map((route) => (
                  <TableRow
                    key={`${route.url}:${route.project}:${route.target}`}
                    className="border-rule/60"
                  >
                    <TableCell className="px-4 py-2">
                      <a href={route.url} target="_blank" rel="noreferrer">
                        {route.host}
                        {route.prefix === "/" ? "" : route.prefix}
                      </a>
                      {!route.published ? (
                        <span className="ml-2 text-xs text-warn">
                          not published
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        <ArrowRight
                          className="size-3.5 text-muted-foreground"
                          aria-hidden
                        />
                        {route.service}
                        {route.upstream ? (
                          <Mono className="break-normal text-muted-foreground">
                            {route.upstream}
                          </Mono>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        <KindTag kind={route.kind} />
                        <Link href={projectHref(route.project)}>
                          {route.project}
                        </Link>
                        /
                        <Link href={targetHref(route.project, route.target)}>
                          {route.target}
                        </Link>
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-2">
                      <StatePill value={route.state} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
      <Panel
        title="Custom Caddy config"
        description="Directives you own, served beside Rig's generated routes."
      >
        {custom.supported ? (
          <pre className="overflow-x-auto rounded-md bg-pane p-3 font-mono text-xs leading-5 text-on-pane">
            {custom.file.raw}
          </pre>
        ) : (
          <p className="flex items-start gap-3 text-sm text-muted-foreground">
            <FileCode2 className="mt-0.5 size-5 shrink-0" aria-hidden />
            {custom.reason}
          </p>
        )}
      </Panel>
    </>
  );
}
