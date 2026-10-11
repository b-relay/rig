import Link from "next/link";
import { CalendarClock, TriangleAlert } from "lucide-react";
import { HEALTH_WORD } from "@/lib/health";
import {
  matrixTile,
  type MatrixRow,
  type ProjectMatrix as Matrix,
} from "@/lib/matrix";
import { targetWarnings } from "@/lib/present";
import { targetHref } from "@/lib/target";
import type { TargetReport } from "@/lib/types";
import {
  CARD,
  Dot,
  EYEBROW,
  HEALTH_DOT,
  HEALTH_TILE,
  Hostnames,
  Revision,
} from "./bits";
import { ProjectIcon } from "./project-icon";
import { TargetActions } from "./target-actions";
import { cn } from "@/lib/utils";

/* One Project as a matrix of surfaces: its Targets across the top as cards (state, branch @ commit,
 * domain, actions), its Services, stores, Tools and jobs down the side, and a tinted tile for each
 * row on each Target, with a dashed outline where the Target has no such row. The Project itself is
 * named in the corner, nothing more. */

/** A column's width never depends on its text (`contain: inline-size`), so the Target row and the
 * tiles come out exactly as wide as each other and scroll the same distance. On a phone a column is
 * nearly the width left beside the frozen column, so one Target shows at a time with the next
 * peeking in. */
const COLUMN =
  "min-w-[11.5rem] max-w-72 flex-1 basis-0 [contain:inline-size] sm:min-w-44";
/** Target cards are one fixed height, so the frozen row is too. */
const CARD_HEIGHT = "h-28";
/** Every row is one fixed height, so the frozen column lines up with the tiles. */
const ROW_HEIGHT = "h-12";
/** One scroll area holds everything, so the frozen row and column move in the very same frame as
 * the tiles. Where tiles pass beneath a frozen edge they fade out across a 0.5rem margin; that
 * margin, the gap between tiles and the snap offset are all the same 0.5rem, so once a scroll
 * settles the tile you scrolled past sits wholly under the solid frozen area and the next one
 * starts exactly where the fade ends. Only tiles in motion are ever partly faded. */
const EDGE_X = "w-2 shrink-0 bg-linear-to-r from-background to-transparent";
const EDGE_Y = "h-2 shrink-0 bg-linear-to-b from-background to-transparent";
/** The frozen left column, its fading edge included in its width. */
const FROZEN_LEFT = "sticky left-0 flex w-32 shrink-0 sm:w-40";
/** The far edges fade too; trailing padding keeps the last tile clear of them at rest. */
const FADE_FAR =
  "[mask-image:linear-gradient(to_left,transparent,black_0.5rem),linear-gradient(to_top,transparent,black_0.5rem)] [mask-composite:intersect]";
const ROW_KIND_ICON = { job: CalendarClock } as const;

export function ProjectMatrix({
  matrix,
  now,
  corner = "project",
}: {
  matrix: Matrix;
  /** The instant job times are measured from, so a render is stable. */
  now: number;
  /** On a Project's own page the corner names the rows instead of repeating the Project. */
  corner?: "project" | "rows";
}) {
  const { columns, rows } = matrix;
  return (
    <div className="flex flex-col gap-2">
      {/* Snap offsets: the frozen row is the cards' h-28 plus the h-2 edge (7.5rem); the frozen
          column is its own width. */}
      <section
        aria-label={`${matrix.project} Targets`}
        className={cn(
          "no-scrollbar max-h-[min(80dvh,40rem)] snap-both snap-mandatory scroll-pt-[7.5rem] scroll-pl-32 overflow-auto overscroll-x-contain sm:scroll-pl-40",
          FADE_FAR,
        )}
      >
        <div className="flex w-max min-w-full flex-col">
          <div className="sticky top-0 z-20 flex flex-col">
            <div className="flex bg-background">
              <div className={cn(FROZEN_LEFT, "z-30")}>
                <div className="min-w-0 flex-1 bg-background">
                  {corner === "project" ? (
                    <Corner matrix={matrix} />
                  ) : (
                    <div className="flex h-full items-end px-3 pb-2">
                      <span className={EYEBROW}>Services</span>
                    </div>
                  )}
                </div>
                <div aria-hidden className={EDGE_X} />
              </div>
              <div className="flex flex-1 gap-2 pr-2">
                {matrix.problem ? (
                  <Gap tone="bad" href={matrix.problem.href}>
                    {matrix.problem.text}
                  </Gap>
                ) : columns.length === 0 ? (
                  <Gap href={`${matrix.href}/config`}>
                    No Target is on. Turn one on under <code>targets</code> in
                    rig.yaml.
                  </Gap>
                ) : (
                  columns.map((target) => (
                    <TargetCard
                      key={target.name}
                      project={matrix.project}
                      target={target}
                    />
                  ))
                )}
              </div>
            </div>
            {rows.length ? <div aria-hidden className={EDGE_Y} /> : null}
          </div>
          <div className="flex flex-col">
            {rows.map((row) => (
              <div key={row.key} className="flex">
                <div className={cn(FROZEN_LEFT, "z-10")}>
                  <div className="min-w-0 flex-1 bg-background pb-2">
                    <RowLabel row={row} />
                  </div>
                  <div aria-hidden className={EDGE_X} />
                </div>
                <div className="flex flex-1 gap-2 pr-2 pb-2">
                  {columns.map((target) => (
                    <Cell
                      key={target.name}
                      target={target}
                      row={row}
                      now={now}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      {matrix.notices.length ? (
        <ul className="flex flex-col gap-1 pl-1">
          {matrix.notices.map((notice) => (
            <li
              key={notice.text}
              className={cn(
                "flex gap-2 text-xs leading-5",
                notice.tone === "bad" ? "text-bad" : "text-warn",
              )}
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">{notice.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
/** The corner is the Project's own card, one surface among the others: its icon centred with the
 * health dot set into the icon's corner like a status badge, and its name beneath. */
function Corner({ matrix }: { matrix: Matrix }) {
  return (
    <Link
      href={matrix.href}
      className={cn(
        CARD,
        CARD_HEIGHT,
        "group flex flex-col items-center justify-center gap-2 px-2 text-foreground no-underline transition-colors hover:bg-accent/60",
      )}
    >
      <span className="relative">
        <ProjectIcon
          project={matrix.project}
          favicon={matrix.stableRoute !== undefined}
        />
        <span
          role="img"
          aria-label={HEALTH_WORD[matrix.health]}
          title={HEALTH_WORD[matrix.health]}
          className={cn(
            "absolute -right-1 -bottom-1 size-3.5 rounded-full ring-[3px] ring-card",
            HEALTH_DOT[matrix.health],
          )}
        />
      </span>
      <span className="max-w-full truncate text-sm font-semibold tracking-tight group-hover:underline group-hover:underline-offset-4">
        {matrix.project}
      </span>
    </Link>
  );
}
/** In place of the Target cards when there are none to show: why, and where to fix it. */
function Gap({
  tone,
  href,
  children,
}: {
  tone?: "bad";
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        CARD_HEIGHT,
        "flex min-w-[11.5rem] flex-1 flex-col justify-center gap-1.5 rounded-xl border border-dashed px-4 text-xs leading-5 sm:max-w-md",
        tone === "bad" ? "border-bad/40 text-bad" : "text-muted-foreground",
      )}
    >
      <p className="line-clamp-3">{children}</p>
      <Link href={href} className="text-xs font-medium">
        {tone === "bad" ? "Open the Project" : "Open the config"}
      </Link>
    </div>
  );
}
/** A Target as its own card: state and name with its actions, then branch @ commit and domain. */
function TargetCard({
  project,
  target,
}: {
  project: string;
  target: TargetReport;
}) {
  const warnings = targetWarnings(target);
  return (
    <div
      className={cn(
        COLUMN,
        CARD_HEIGHT,
        CARD,
        "@container flex flex-col justify-between gap-2 overflow-hidden p-3",
      )}
    >
      {/* The dot is the state; its word is in the tooltip and for screen readers. */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <Dot value={target.state} />
          <Link
            href={targetHref(project, target.name)}
            className={cn(
              "truncate font-semibold no-underline hover:underline hover:underline-offset-4",
              target.state === "configured"
                ? "text-muted-foreground"
                : "text-foreground",
            )}
            title={
              target.kind === "preview"
                ? `Preview ${target.name}: ${target.state}`
                : `${target.name}: ${target.state}`
            }
          >
            {target.name}
          </Link>
          {warnings.length ? (
            <span
              className="inline-flex shrink-0 text-warn"
              title={warnings.join(" ")}
            >
              <TriangleAlert className="size-3.5" aria-hidden />
              <span className="sr-only">{warnings.join(" ")}</span>
            </span>
          ) : null}
        </span>
        <div className="-my-1.5 -mr-1.5 shrink-0">
          <TargetActions project={project} target={target} layout="card" />
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
        <Revision target={target} />
        <Hostnames
          target={target}
          linkClassName="text-foreground no-underline hover:underline hover:underline-offset-4"
        />
      </div>
    </div>
  );
}
function RowLabel({ row }: { row: MatrixRow }) {
  const Icon = row.kind === "job" ? ROW_KIND_ICON.job : undefined;
  return (
    <div
      className={cn(
        ROW_HEIGHT,
        "flex flex-col justify-center rounded-lg border bg-card px-3 py-1",
      )}
    >
      <span className="truncate leading-5 font-medium" title={row.name}>
        {row.name}
      </span>
      <span className="flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
        {Icon ? <Icon className="size-3" aria-hidden /> : null}
        {row.kind}
      </span>
    </div>
  );
}
/** One row on one Target, tinted by how it is doing; a dashed outline where it does not exist. */
function Cell({
  target,
  row,
  now,
}: {
  target: TargetReport;
  row: MatrixRow;
  now: number;
}) {
  const tile = matrixTile(target, row, now);
  if (tile.absent)
    return (
      <div
        className={cn(
          COLUMN,
          ROW_HEIGHT,
          "flex snap-start items-center rounded-lg border border-dashed px-3 text-xs text-muted-foreground",
        )}
      >
        <span aria-hidden>—</span>
        <span className="sr-only">
          {target.name} has no {row.name}
        </span>
      </div>
    );
  return (
    <div
      className={cn(
        COLUMN,
        ROW_HEIGHT,
        "flex snap-start items-center justify-between gap-2 rounded-lg px-3 text-xs",
        HEALTH_TILE[tile.health],
      )}
      title={tile.title}
    >
      <span className="flex min-w-0 items-center gap-1.5 font-medium">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            HEALTH_DOT[tile.health],
            tile.busy && "busy-dot",
          )}
        />
        <span className="truncate">{tile.word}</span>
      </span>
      {tile.detail ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          {tile.detail}
        </span>
      ) : null}
    </div>
  );
}
/** The frame of a Project's matrix while its status is on its way. */
export function MatrixLoading({ project }: { project: string }) {
  return (
    <div className="flex gap-2" role="status" aria-label={`Loading ${project}`}>
      <div
        className={cn(
          CARD,
          CARD_HEIGHT,
          "flex w-30 shrink-0 flex-col items-center justify-center gap-2 sm:w-38",
        )}
      >
        <ProjectIcon project={project} />
        <span className="text-sm font-semibold">{project}</span>
      </div>
      {[0, 1].map((index) => (
        <div
          key={index}
          className={cn(
            CARD,
            CARD_HEIGHT,
            COLUMN,
            "animate-pulse bg-muted/60 shadow-none",
            index && "hidden sm:block",
          )}
        />
      ))}
    </div>
  );
}
