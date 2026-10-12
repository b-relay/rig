"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Dot } from "./bits";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** One Target the chip can switch to. */
export interface ChipTarget {
  /** `stable`, `working`, or the Preview's name. */
  readonly name: string;
  readonly state: string;
  /** What it uses now, already worded (`96% · 1.5 GB`). */
  readonly detail?: string;
  /** The tab showing this Target. */
  readonly href: string;
}

/** Which Target a Project's Monitor tab shows, as a monospace chip beside its range: the Target's name as the CLI
 * prints it and a dot for its state. It opens a menu of every Target with what each uses now, and `all targets`. */
export function TargetChip({
  current,
  targets,
  allDetail,
  allHref,
}: {
  /** The Target shown, or `all` for every Target together. */
  current: string;
  targets: readonly ChipTarget[];
  /** What all Targets together use now. */
  allDetail?: string;
  /** The tab showing every Target together. */
  allHref: string;
}) {
  const selected = targets.find((target) => target.name === current);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-8 items-center gap-2 rounded-lg border bg-muted/60 px-2.5 font-mono text-[13px] font-medium shadow-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
        {selected ? (
          <Dot value={selected.state} className="size-1.5" />
        ) : (
          <span aria-hidden className="size-1.5 rounded-full bg-chart-3" />
        )}
        {selected?.name ?? "all targets"}
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-72 font-mono text-xs">
        {targets.map((target) => (
          <DropdownMenuItem key={target.name} asChild>
            <Link
              href={target.href}
              className="flex items-center gap-2"
              aria-current={target.name === current ? "page" : undefined}
            >
              <Dot value={target.state} className="size-1.5" />
              <span className="min-w-0 flex-1 truncate">{target.name}</span>
              {target.detail ? (
                <span className="text-muted-foreground tabular-nums">
                  {target.detail}
                </span>
              ) : null}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={allHref} className="flex items-center gap-2">
            <span aria-hidden className="size-1.5 rounded-full bg-chart-3" />
            <span className="flex-1 text-muted-foreground">all targets</span>
            {allDetail ? (
              <span className="text-muted-foreground tabular-nums">
                {allDetail}
              </span>
            ) : null}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
