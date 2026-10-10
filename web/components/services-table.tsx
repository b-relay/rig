import { healthSummary } from "@/lib/present";
import { componentPorts, exitText } from "@/lib/target-detail";
import type { ComponentReport } from "@/lib/types";
import { Mono, StatePill } from "./bits";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const HEAD =
  "h-8 px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";
const DASH = <span className="text-muted-foreground/60">–</span>;
/** A Target's Services, each on one row: state, cached health, every port by name, process id,
 * automatic restarts, and what rigd said about it. */
export function ServicesTable({
  components,
  now,
}: {
  components: readonly ComponentReport[];
  /** The instant health ages are measured from, so a render is stable. */
  now: Date;
}) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[48rem] text-[13px]">
        <TableHeader>
          <TableRow className="border-rule hover:bg-transparent">
            <TableHead className={HEAD}>Service</TableHead>
            <TableHead className={HEAD}>State</TableHead>
            <TableHead className={HEAD}>Health</TableHead>
            <TableHead className={HEAD}>Ports</TableHead>
            <TableHead className={HEAD}>PID</TableHead>
            <TableHead className={HEAD}>Restarts</TableHead>
            <TableHead className={HEAD}>Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {components.map((component) => {
            const health = healthSummary(component, now);
            const ports = componentPorts(component);
            const exit = exitText(component);
            return (
              <TableRow key={component.name} className="border-rule/60">
                <TableCell className="px-4 py-2 font-medium">
                  {component.name}
                  {component.kind !== "managed" ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {component.kind === "installed" ? "tool" : component.kind}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="px-4 py-2">
                  <StatePill value={component.state} />
                </TableCell>
                <TableCell className="max-w-64 px-4 py-2 whitespace-normal text-muted-foreground">
                  {health ?? DASH}
                </TableCell>
                <TableCell className="px-4 py-2">
                  {ports.length
                    ? ports.map(({ name, port }) => (
                        <span key={name} className="mr-3 inline-flex gap-1">
                          {name ? (
                            <span className="text-muted-foreground">
                              {name}
                            </span>
                          ) : null}
                          <Mono className="break-normal">{port}</Mono>
                        </span>
                      ))
                    : DASH}
                </TableCell>
                <TableCell className="px-4 py-2">
                  {component.pid ? (
                    <Mono className="break-normal">{component.pid}</Mono>
                  ) : (
                    DASH
                  )}
                </TableCell>
                <TableCell className="px-4 py-2 tabular-nums">
                  {component.kind === "managed" ? (
                    component.restarts ? (
                      <span className="text-warn">{component.restarts}</span>
                    ) : (
                      "0"
                    )
                  ) : (
                    DASH
                  )}
                </TableCell>
                <TableCell className="max-w-96 px-4 py-2 whitespace-normal text-muted-foreground">
                  {[exit, component.reason].filter(Boolean).join(" ") || DASH}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
