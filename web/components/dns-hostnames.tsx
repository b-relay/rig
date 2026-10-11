"use client";

import { Crosshair } from "lucide-react";
import { VERDICT, fixCommand, fixDescription, sourcesLabel } from "@/lib/dns";
import type { HostnameCheck } from "@/lib/types";
import { CARD, Failure, HEALTH_DOT, HEALTH_TILE, Mono } from "./bits";
import { useRun } from "./operations";
import { Confirm } from "./confirm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Every hostname Rig serves and where DNS sends it, with a one-click fix for each that does not reach this Mac. */
export function DnsHostnames({
  checks,
  address,
  addressSource,
}: {
  checks: readonly HostnameCheck[];
  address?: string;
  addressSource?: "config" | "tailscale";
}) {
  const off = checks.filter((check) => check.verdict !== "mac").length;
  return (
    <section className={cn("flex min-w-0 flex-col overflow-hidden", CARD)}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 pt-3.5 pb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Where your hostnames point</h3>
          <p className="text-xs text-muted-foreground">
            {checks.length === 0
              ? "Rig serves no hostname yet."
              : off === 0
                ? "Every hostname Rig serves points at this Mac."
                : `${off} of ${checks.length} ${checks.length === 1 ? "hostname does" : "hostnames do"} not point at this Mac.`}{" "}
            A name covered only by a wildcard counts when the wildcard points
            here.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          This Mac:{" "}
          {address ? (
            <>
              <Mono className="text-foreground">{address}</Mono> (
              {addressSource === "config" ? "proxy.dns.address" : "Tailscale"})
            </>
          ) : (
            <span className="text-warn">
              unknown: set proxy.dns.address, or install Tailscale
            </span>
          )}
        </p>
      </header>
      {checks.length ? (
        <ul className="divide-y border-t">
          {checks.map((check) => (
            <HostnameRow key={check.hostname} check={check} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
/** One hostname: who serves it, what DNS answers, the verdict, and the fix or why there is none. */
export function HostnameRow({ check }: { check: HostnameCheck }) {
  const act = useRun();
  const verdict = VERDICT[check.verdict];
  const done = act.result !== undefined;
  return (
    <li className="grid gap-x-4 gap-y-1.5 px-4 py-3 text-sm md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_11rem] md:items-center">
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{check.hostname}</span>
          <span
            className={cn(
              "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium",
              HEALTH_TILE[verdict.health],
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                HEALTH_DOT[verdict.health],
              )}
            />
            {verdict.word}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {sourcesLabel(check.sources)}
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 text-xs">
        <span className="text-foreground">{check.reason}</span>
        {check.wildcard && check.answeredBy ? (
          <span className="text-muted-foreground">
            via the wildcard <Mono>{check.answeredBy}</Mono>
          </span>
        ) : null}
        {check.chain.map((hop) => (
          <Mono key={hop} className="text-muted-foreground">
            {hop}
          </Mono>
        ))}
        {check.addresses.length ? (
          <Mono className="text-muted-foreground">
            {check.addresses
              .map(
                (each) =>
                  `${each.type} ${each.content}${each.proxied ? " (proxied)" : ""}`,
              )
              .join(", ")}
          </Mono>
        ) : null}
        {check.fix && !done ? (
          <span className="text-muted-foreground">
            {fixDescription(check.fix)}
          </span>
        ) : check.fixBlocked ? (
          <span className="text-warn">{check.fixBlocked}</span>
        ) : null}
        {act.failure ? <Failure failure={act.failure} /> : null}
      </span>
      <span className="flex md:justify-end">
        {check.fix ? (
          // Adding a record is one click; changing one that exists is confirmed first, since it moves the name.
          <Confirm
            when={check.fix.op === "update"}
            title={`Point ${check.hostname} at this Mac?`}
            description={fixDescription(check.fix)}
            confirmLabel="Change the record"
            onConfirm={() => void act.run(fixCommand(check.fix!))}
          >
            <Button
              size="sm"
              variant={done ? "outline" : "default"}
              disabled={act.busy || done}
            >
              <Crosshair />
              {done
                ? "Pointed at this Mac"
                : act.busy
                  ? "Pointing…"
                  : "Point at this Mac"}
            </Button>
          </Confirm>
        ) : null}
      </span>
    </li>
  );
}
