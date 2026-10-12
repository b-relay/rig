import Link from "next/link";
import { USAGE_RANGES, type UsageRange } from "../../src/domain/usage-summary";
import { cn } from "@/lib/utils";

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
