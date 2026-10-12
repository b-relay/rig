import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, FileCode2, Globe, Network } from "lucide-react";
import type { Failure as FailureShape } from "@/lib/outcome";
import type { ProjectEntry } from "@/lib/overview";
import {
  managedProxyRoutes,
  ownRoutesNote,
  pendingNote,
  proxyRoutes,
} from "@/lib/proxy";
import { projectHref, targetHref } from "@/lib/target";
import {
  dnsReport,
  projectList,
  projectStatus,
  proxyReport,
} from "@/server/status";
import { dnsSetup } from "@/lib/dns";
import type { Outcome } from "@/lib/outcome";
import type { DnsReport } from "@/lib/types";
import { DnsHostnames } from "@/components/dns-hostnames";
import { DnsZoneRecords } from "@/components/dns-records";
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
/** DNS (ADR 0018): where each served hostname points, then every zone's records with Add, Edit and Delete; or, when rigd
 * cannot read them, what is missing and how to set it up. */
function DnsSection({ read }: { read: Outcome<DnsReport> }) {
  return (
    <section id="dns" className="flex scroll-mt-20 flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold">DNS</h2>
        <p className="text-xs text-muted-foreground">
          Your Cloudflare records, changed through rigd with the token rig proxy
          token stored. The page never sees the token; Activity records every
          change.
        </p>
      </div>
      {read.ok ? (
        <>
          {read.value.unreadableZones?.map((failure) => (
            <Warning key={failure.zone} className="text-sm">
              The records of {failure.zone} could not be read ({failure.code}):{" "}
              {failure.message}
            </Warning>
          ))}
          {read.value.unseenZones?.length ? (
            <Warning className="text-sm">
              The DNS token cannot see {read.value.unseenZones.join(", ")},
              which proxy.dns.zones names.
            </Warning>
          ) : null}
          <DnsHostnames
            checks={read.value.hostnames}
            {...(read.value.address ? { address: read.value.address } : {})}
            {...(read.value.addressSource
              ? { addressSource: read.value.addressSource }
              : {})}
          />
          {read.value.zones.length === 0 ? (
            <Empty icon={Globe} title="No zone">
              The DNS token sees no zone. Give it Zone:Zone:Read and
              Zone:DNS:Edit on your zone in the Cloudflare dashboard.
            </Empty>
          ) : (
            read.value.zones.map((zone) => (
              <DnsZoneRecords
                key={zone.id}
                zone={zone}
                records={read.value.records.filter(
                  (record) => record.zone === zone.name,
                )}
              />
            ))
          )}
        </>
      ) : (
        <DnsUnavailable failure={read.failure} />
      )}
    </section>
  );
}
function DnsUnavailable({ failure }: { failure: FailureShape }) {
  const setup = dnsSetup(failure);
  return (
    <Empty icon={Globe} title={setup.title}>
      <ol className="list-decimal space-y-1 pl-4">
        {setup.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </Empty>
  );
}
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
  const [proxy, dns] = await Promise.all([proxyReport(), dnsReport()]);
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
          routes are inert. <Link href="/monitor">Doctor, on Monitor,</Link>{" "}
          names the fix.
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
      <DnsSection read={dns} />
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
