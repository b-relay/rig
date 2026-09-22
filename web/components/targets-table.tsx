"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Columns3,
  TriangleAlert,
} from "lucide-react";
import {
  columnFilteringFeature,
  columnPinningFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type Column,
  type ColumnVisibilityState,
} from "@tanstack/react-table";
import { z } from "zod";
import { KIND_RANK, type TargetRow } from "@/lib/board-rows";
import { shortCommit, toneOf } from "@/lib/present";
import { routeUrl, targetKey } from "@/lib/target";
import type { ComponentReport } from "@/lib/types";
import { Mono, State } from "./bits";
import { StartWorkingCopy } from "./start-working-copy";
import { TargetActions } from "./target-actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  columnVisibilityFeature,
  columnPinningFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
});
type Features = typeof features;
const helper = createColumnHelper<Features, TargetRow>();
const DASH = <span className="text-muted-foreground/70">–</span>;
const NO_ROWS: TargetRow[] = [];
/** Column choices survive a reload; the key names the table, so another table can keep its own. */
const STORAGE_KEY = "rig.board.columns";
const visibilitySchema = z.record(z.string(), z.boolean());

const columns = helper.columns([
  helper.accessor("name", {
    id: "target",
    header: "Target",
    enableHiding: false,
    cell: ({ row }) => <TargetName row={row.original} />,
  }),
  helper.accessor("project", {
    header: "Project",
    cell: ({ row }) => (
      <Link
        href={row.original.projectHref}
        className="text-ink no-underline hover:underline"
      >
        {row.original.project}
      </Link>
    ),
  }),
  helper.accessor("kindLabel", {
    id: "kind",
    header: "Kind",
    sortFn: (a, b) => KIND_RANK[a.original.kind] - KIND_RANK[b.original.kind],
    cell: ({ getValue }) => (
      <span className="text-muted-foreground">{getValue()}</span>
    ),
  }),
  helper.accessor("state", {
    header: "State",
    cell: ({ row }) =>
      row.original.target ? (
        <span className="inline-flex items-center gap-2">
          <State value={row.original.state} />
          {row.original.warnings.length ? (
            <span
              className="inline-flex text-warn"
              title={row.original.warnings.join(" ")}
            >
              <TriangleAlert className="size-3.5" aria-hidden />
              <span className="sr-only">{row.original.warnings.join(" ")}</span>
            </span>
          ) : null}
        </span>
      ) : (
        DASH
      ),
  }),
  helper.accessor("branch", {
    header: "Branch",
    cell: ({ getValue }) => {
      const branch = getValue();
      return branch ? (
        <span className="block max-w-48 truncate" title={branch}>
          {branch}
        </span>
      ) : (
        DASH
      );
    },
  }),
  helper.accessor("commit", {
    header: "Commit",
    cell: ({ getValue }) => {
      const commit = getValue();
      return commit ? (
        <Mono className="break-normal" title={commit}>
          {shortCommit(commit)?.slice(0, 7)}
        </Mono>
      ) : (
        DASH
      );
    },
  }),
  helper.accessor("route", {
    header: "Route",
    cell: ({ getValue }) => {
      const route = getValue();
      return route ? (
        <a
          href={routeUrl(route)}
          target="_blank"
          rel="noreferrer"
          className="block max-w-72 truncate"
          title={route}
        >
          {route}
        </a>
      ) : (
        DASH
      );
    },
  }),
  helper.accessor("componentsText", {
    id: "components",
    header: "Components",
    enableSorting: false,
    cell: ({ row }) => <Components components={row.original.components} />,
  }),
  helper.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    enableHiding: false,
    cell: ({ row }) =>
      row.original.target ? (
        <TargetActions
          project={row.original.project}
          target={row.original.target}
        />
      ) : (
        <span className="flex justify-end">
          <StartWorkingCopy project={row.original.project} compact />
        </span>
      ),
  }),
]);

/** Every Target as one dense line, in a data table: sort by any column, filter by any word,
 * choose the columns, and the Target column stays put while the rest scroll sideways. */
export function TargetsTable({
  rows,
  hideProject = false,
  loading = false,
}: {
  rows: readonly TargetRow[];
  /** On a Project's own page the Project column says nothing new. */
  hideProject?: boolean;
  /** The statuses are still on their way; the table says so rather than "no Target". */
  loading?: boolean;
}) {
  const shown = useMemo(
    () =>
      hideProject
        ? columns.filter((column) => column.id !== "project")
        : columns,
    [hideProject],
  );
  const [filter, setFilter] = useState("");
  const [visibility, setVisibility] = useVisibility();
  const table = useTable({
    features,
    columns: shown,
    data: rows.length ? (rows as TargetRow[]) : NO_ROWS,
    getRowId: (row) => row.id,
    initialState: { columnPinning: { start: ["target"], end: ["actions"] } },
    state: { globalFilter: filter, columnVisibility: visibility },
    onGlobalFilterChange: (updater) =>
      setFilter((old) =>
        typeof updater === "function" ? String(updater(old)) : String(updater),
      ),
    onColumnVisibilityChange: setVisibility,
  });
  const body = table.getRowModel().rows;
  const columnCount = table.getVisibleLeafColumns().length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          value={filter}
          onChange={(event) => table.setGlobalFilter(event.target.value)}
          placeholder="Filter…"
          aria-label="Filter Targets"
          className="h-8 max-w-56 text-sm md:text-sm"
        />
        <span className="text-xs text-muted-foreground">
          {filter
            ? `${body.length} of ${rows.length}`
            : `${rows.length} ${rows.length === 1 ? "Target" : "Targets"}`}
        </span>
        <div className="ml-auto">
          <ColumnsMenu columns={table.getAllLeafColumns()} />
        </div>
      </div>
      <div className="-mx-4 bg-sheet sm:mx-0 sm:rounded-md sm:border sm:border-rule">
        <Table className="min-w-[56rem] text-[13px] leading-5">
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="border-rule hover:bg-sheet">
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={cn(
                      "h-8 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
                      pinnedClass(header.column, "head"),
                    )}
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 uppercase hover:text-ink"
                      >
                        <table.FlexRender header={header} />
                        <SortMark direction={header.column.getIsSorted()} />
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {body.map((row) => (
              <TableRow
                key={row.id}
                className="group border-rule/60 hover:bg-muted"
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      "px-3 py-1.5",
                      cell.column.id === "actions" && "text-right",
                      pinnedClass(cell.column, "cell"),
                    )}
                  >
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {body.length === 0 ? (
              <TableRow className="hover:bg-sheet">
                <TableCell
                  colSpan={columnCount}
                  className="px-3 py-2 text-muted-foreground"
                >
                  {loading ? (
                    <>
                      <span
                        aria-hidden
                        className="busy-dot mr-2 inline-block size-2 rounded-full bg-busy"
                      />
                      Reading status…
                    </>
                  ) : filter ? (
                    `No Target matches “${filter}”.`
                  ) : (
                    "No Target yet."
                  )}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
/** The classes that keep a pinned column in view while the rest scroll under it. */
function pinnedClass(
  column: Column<Features, TargetRow, unknown>,
  part: "head" | "cell",
): string | undefined {
  const side = column.getIsPinned();
  if (!side) return undefined;
  return cn(
    "sticky bg-sheet",
    part === "head" ? "z-20" : "z-10 group-hover:bg-muted",
    side === "start"
      ? "left-0 border-r border-rule"
      : "right-0 border-l border-rule",
  );
}
function SortMark({ direction }: { direction: false | "asc" | "desc" }) {
  if (direction === "asc") return <ArrowUp className="size-3" aria-hidden />;
  if (direction === "desc") return <ArrowDown className="size-3" aria-hidden />;
  return (
    <ChevronsUpDown
      className="size-3 opacity-0 group-hover:opacity-100 hover:opacity-100"
      aria-hidden
    />
  );
}
function ColumnsMenu({
  columns,
}: {
  columns: Column<Features, TargetRow, unknown>[];
}) {
  const choosable = columns.filter((column) => column.getCanHide());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs" aria-label="Choose columns">
          <Columns3 /> Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {choosable.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            onCheckedChange={(checked) => column.toggleVisibility(!!checked)}
          >
            {typeof column.columnDef.header === "string"
              ? column.columnDef.header
              : column.id}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
/** Which columns are shown, remembered in this browser; nothing is read until the page is
 * on screen, so the server's and the browser's first render agree. */
function useVisibility(): [
  ColumnVisibilityState,
  (
    updater:
      | ColumnVisibilityState
      | ((old: ColumnVisibilityState) => ColumnVisibilityState),
  ) => void,
] {
  const [visibility, setVisibility] = useState<ColumnVisibilityState>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const saved = visibilitySchema.safeParse(
        JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"),
      );
      if (saved.success) setVisibility(saved.data);
    } catch {
      // A browser without storage, or a value from another version: start from every column.
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility));
    } catch {
      // Storage is a convenience; the table works without it.
    }
  }, [loaded, visibility]);
  return [visibility, setVisibility];
}
function TargetName({ row }: { row: TargetRow }) {
  if (!row.target)
    return (
      <span
        className="text-muted-foreground italic"
        title="The Working copy runs the files on disk, without a deploy. Start it from this row."
      >
        {row.name}
      </span>
    );
  return (
    <Link
      href={`${row.projectHref}/logs?target=${encodeURIComponent(targetKey(row.target))}`}
      className="font-medium text-ink no-underline hover:underline"
      title="Logs"
    >
      {row.name}
    </Link>
  );
}
/** Each component on the one line: a state dot, its name and its port, the way `rig status` prints them. */
function Components({
  components,
}: {
  components: readonly ComponentReport[];
}) {
  if (components.length === 0) return DASH;
  return (
    <span className="inline-flex items-center gap-3">
      {components.map((component) => (
        <span
          key={component.name}
          className="inline-flex items-center gap-1.5"
          title={[
            component.state,
            component.pid ? `pid ${component.pid}` : undefined,
            component.reason,
          ]
            .filter(Boolean)
            .join(", ")}
        >
          <span
            aria-hidden
            className={cn("size-2 rounded-full", DOT[toneOf(component.state)])}
          />
          <span className="sr-only">{component.state}</span>
          {component.name}
          {component.port ? (
            <Mono className="break-normal text-muted-foreground">
              :{component.port}
            </Mono>
          ) : null}
        </span>
      ))}
    </span>
  );
}
const DOT = {
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  busy: "bg-busy busy-dot",
  idle: "bg-muted-ink/60",
};
