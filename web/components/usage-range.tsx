import Link from "next/link";
import { USAGE_RANGES, type UsageRange } from "../../src/domain/usage-summary";
import { cn } from "@/lib/utils";

/** Pure: the range a page's `?range=` asks for, or 1h when it names none Rig keeps. */
export function rangeOf(value: string | undefined): UsageRange {
  return (USAGE_RANGES as readonly string[]).includes(value ?? "")
    ? (value as UsageRange)
    : "1h";
}

/** The span a Monitor page charts, as three plain words; the current one underlined. Each keeps the page's other
 * query values. */
export function RangeTabs({
  current,
  query = {},
}: {
  current: UsageRange;
  query?: Readonly<Record<string, string>>;
}) {
  return (
    <nav aria-label="Range" className="flex items-center gap-4 text-sm">
      {USAGE_RANGES.map((range) => (
        <Link
          key={range}
          href={`?${new URLSearchParams({ ...query, range })}`}
          aria-current={range === current ? "page" : undefined}
          className={cn(
            "font-mono tabular-nums underline-offset-[6px]",
            range === current
              ? "font-semibold text-foreground underline decoration-2"
              : "text-muted-foreground hover:text-foreground",
          )}
          scroll={false}
        >
          {range}
        </Link>
      ))}
    </nav>
  );
}
