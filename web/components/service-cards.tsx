import { healthOf } from "@/lib/health";
import { healthSummary, toneOf } from "@/lib/present";
import { componentPorts, exitText } from "@/lib/target-detail";
import type { ComponentReport } from "@/lib/types";
import { CARD, HEALTH_DOT, HEALTH_TILE } from "./bits";
import { cn } from "@/lib/utils";

const KIND = { managed: "service", persistent: "store", installed: "tool" };
/** A Target's Services and Tools, each as a card: its state as a tinted tile, then cached health,
 * every port by name, process id, automatic restarts, and what rigd said about it. */
export function ServiceCards({
  components,
  now,
}: {
  components: readonly ComponentReport[];
  /** The instant health ages are measured from, so a render is stable. */
  now: Date;
}) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {components.map((component) => {
        const health = healthOf(component.state);
        const ports = componentPorts(component);
        const detail = [exitText(component), component.reason]
          .filter(Boolean)
          .join(" ");
        const summary = healthSummary(component, now);
        return (
          <li key={component.name} className={cn(CARD, "flex flex-col p-3")}>
            <div className="flex items-start justify-between gap-3 px-1 pb-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{component.name}</p>
                <p className="text-xs text-muted-foreground">
                  {KIND[component.kind]}
                </p>
              </div>
              {ports.length ? (
                <div className="flex flex-wrap justify-end gap-1">
                  {ports.map(({ name, port }) => (
                    <span
                      key={name ?? port}
                      className="inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-mono text-[11px] tabular-nums"
                    >
                      {name ? (
                        <span className="text-muted-foreground">{name}</span>
                      ) : null}
                      :{port}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div
              className={cn(
                "flex min-h-12 flex-col justify-center gap-0.5 rounded-lg px-3 py-2 text-xs",
                HEALTH_TILE[health],
              )}
            >
              <span className="flex items-center gap-1.5 font-medium">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    HEALTH_DOT[health],
                    toneOf(component.state) === "busy" && "busy-dot",
                  )}
                />
                {component.state}
              </span>
              {summary ? <span>{summary}</span> : null}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 px-1 text-xs">
              <dt className="text-muted-foreground">PID</dt>
              <dd className="text-right font-mono tabular-nums">
                {component.pid ?? "–"}
              </dd>
              {component.kind === "managed" ? (
                <>
                  <dt
                    className="text-muted-foreground"
                    title="Automatic restart attempts inside rigd's restart budget window; older ones drop off."
                  >
                    Recent restarts
                  </dt>
                  <dd
                    className={cn(
                      "text-right tabular-nums",
                      component.restarts ? "text-warn" : undefined,
                    )}
                  >
                    {component.restarts ?? 0}
                  </dd>
                </>
              ) : null}
            </dl>
            {detail ? (
              <p className="mt-2 border-t px-1 pt-2 text-xs text-muted-foreground">
                {detail}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
