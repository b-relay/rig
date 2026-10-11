import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, FileCode2, Network } from "lucide-react";
import type { ProjectEntry } from "@/lib/overview";
import {
  managedProxyRoutes,
  ownRoutesNote,
  pendingNote,
  proxyRoutes,
} from "@/lib/proxy";
import { projectHref, targetHref } from "@/lib/target";
import { projectList, projectStatus, proxyReport } from "@/server/status";
import {
  CARD,
  Empty,
  Failure,
  KindTag,
  Mono,
  PageHeader,
  Panel,
  Stat,
  State,
  Warning,
} from "@/components/bits";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Proxy" };
/** Every hostname and path Caddy serves for this Host, the Target and Service each reaches, and, with
 * Rig's own Caddy, the owner's own routes from proxy.routes, read-only. */
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
  const proxy = await proxyReport();
  // Rig's own Caddy reports what it serves; otherwise the Host's Caddy serves what status says.
  const routes = proxy.ok
    ? managedProxyRoutes(proxy.value, proxyRoutes(entries))
    : proxyRoutes(entries);
  const hosts = new Set(routes.map((route) => route.host));
  const unpublished = routes.filter((route) => !route.published).length;
  const ownRoutes = routes.filter((route) => route.source === "custom");
  const pending = pendingNote(proxy);
  return (
    <>
      <PageHeader
        title="Proxy"
        description="Every hostname Caddy serves for this Mac, and the loopback Service each path reaches."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Hostnames" value={hosts.size} />
        <Stat label="Routes" value={routes.length} />
        <Stat
          label="Not published"
          value={unpublished}
          tone={unpublished ? "warn" : undefined}
        />
        {proxy.ok ? (
          <Stat
            label="Rig's Caddy"
            value={proxy.value.caddy.state}
            tone={proxy.value.caddy.state === "running" ? "good" : "bad"}
          />
        ) : null}
      </div>
      {pending ? <Warning className="text-sm">{pending}</Warning> : null}
      {unpublished ? (
        <Warning className="text-sm">
          The Host&apos;s Caddy does not load Rig&apos;s route file, so some
          routes are inert. <Link href="/doctor">Doctor</Link> names the fix.
        </Warning>
      ) : null}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Hostnames</h2>
        {routes.length === 0 ? (
          <Empty icon={Network}>
            No Target has a hostname. Set <code>domain</code> in a
            Project&apos;s rig.yaml to publish one.
          </Empty>
        ) : (
          <ul className={cn(CARD, "flex flex-col divide-y")}>
            {routes.map((route) => (
              <li
                key={`${route.url}:${route.source}:${route.project}:${route.target}`}
                className="grid gap-x-6 gap-y-1.5 px-4 py-3 text-sm md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_7rem] md:items-center"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                  <a
                    href={route.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate font-medium"
                  >
                    {route.host}
                    {route.prefix === "/" ? "" : route.prefix}
                  </a>
                  {!route.published ? (
                    <span className="rounded-md bg-warn-fill px-1.5 text-[11px] font-medium text-warn">
                      not published
                    </span>
                  ) : null}
                </span>
                <span className="flex min-w-0 items-center gap-2 text-xs md:text-sm">
                  <ArrowRight
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  {route.source === "custom" ? null : (
                    <span className="truncate">{route.service}</span>
                  )}
                  {route.upstream ? (
                    <Mono className="truncate break-normal text-muted-foreground">
                      {route.upstream}
                    </Mono>
                  ) : null}
                  {route.withheld ? (
                    <span className="shrink-0 text-xs text-warn">
                      withheld (503)
                    </span>
                  ) : null}
                </span>
                <span className="flex min-w-0 items-center gap-2 text-xs md:text-sm">
                  {route.project && route.target ? (
                    <>
                      {route.kind ? <KindTag kind={route.kind} /> : null}
                      <span className="min-w-0 truncate">
                        <Link
                          href={projectHref(route.project)}
                          className="text-foreground"
                        >
                          {route.project}
                        </Link>
                        <span className="text-muted-foreground"> / </span>
                        <Link
                          href={targetHref(route.project, route.target)}
                          className="text-foreground"
                        >
                          {route.target}
                        </Link>
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      Your own route (proxy.routes)
                    </span>
                  )}
                </span>
                <span className="text-xs">
                  {route.state ? <State value={route.state} /> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Panel
        title="Your own routes"
        description="Hostnames outside any Project, each sent to a service on this Mac."
      >
        <p className="flex items-start gap-3 text-sm text-muted-foreground">
          <FileCode2 className="mt-0.5 size-5 shrink-0" aria-hidden />
          <span>
            {proxy.ok
              ? `${ownRoutes.length === 0 ? "None yet." : `${ownRoutes.length} served, listed above.`} `
              : null}
            {ownRoutesNote(proxy)}
          </span>
        </p>
      </Panel>
    </>
  );
}
