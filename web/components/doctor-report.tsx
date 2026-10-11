import { CircleCheck, CircleX } from "lucide-react";
import type { DoctorReport } from "@/lib/types";
import { CARD } from "./bits";
import { cn } from "@/lib/utils";

/** The report as tinted tiles, failed checks first: each names the check and what it found, and a
 * failed one its reason and the hint that fixes it. */
export function DoctorTiles({ report }: { report: DoctorReport }) {
  const failed = report.checks.filter((check) => !check.ok);
  const checks = [...failed, ...report.checks.filter((check) => check.ok)];
  return (
    <div className="flex flex-col gap-4">
      <div className={cn(CARD, "flex items-center gap-3 p-4")}>
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl",
            report.ok ? "bg-good-fill text-good" : "bg-bad-fill text-bad",
          )}
        >
          {report.ok ? (
            <CircleCheck className="size-5" aria-hidden />
          ) : (
            <CircleX className="size-5" aria-hidden />
          )}
        </span>
        <div className="min-w-0">
          <p className="font-semibold">
            {report.ok
              ? "Every check passed"
              : `${failed.length} of ${report.checks.length} checks failed`}
          </p>
          <p className="text-sm text-muted-foreground">
            {report.ok
              ? `${report.checks.length} checks.`
              : "Each failed check names what to do."}
            {report.note ? ` ${report.note}` : ""}
          </p>
        </div>
      </div>
      <ul className="grid items-start gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {checks.map((check) => (
          <li
            key={check.name}
            className={cn(
              "flex flex-col gap-1 rounded-xl p-3.5 text-sm",
              check.ok ? "bg-good-fill" : "bg-bad-fill sm:col-span-full",
            )}
          >
            <p
              className={cn(
                "flex items-center gap-1.5 font-medium",
                check.ok ? "text-good" : "text-bad",
              )}
            >
              {check.ok ? (
                <CircleCheck className="size-4 shrink-0" aria-hidden />
              ) : (
                <CircleX className="size-4 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 break-words">{check.name}</span>
              <span className="sr-only">{check.ok ? "ok" : "failed"}</span>
            </p>
            <p className="text-foreground/85">{check.message}</p>
            {check.reason ? (
              <p className="text-xs text-foreground/70">{check.reason}</p>
            ) : null}
            {check.hint ? (
              <p className="text-xs text-foreground/70">{check.hint}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
