import { CircleCheck, CircleX } from "lucide-react";
import type { DoctorReport } from "@/lib/types";
import { Notice } from "./bits";

const HEAD =
  "px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap";
const CELL = "px-3 py-2 align-top";
/** Each check on one row; a failed check shows its reason and the hint that fixes it. */
export function DoctorTable({ report }: { report: DoctorReport }) {
  return (
    <div className="flex flex-col gap-4">
      <Notice tone={report.ok ? "good" : "warn"}>
        {report.ok
          ? "Every check passed."
          : "Some checks failed; each row names what to do."}
        {report.note ? ` ${report.note}` : ""}
      </Notice>
      <div className="-mx-4 overflow-x-auto sm:mx-0 sm:rounded-md sm:border sm:border-rule sm:bg-sheet">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="border-b border-rule">
            <tr>
              <th className={HEAD}>Check</th>
              <th className={HEAD}>Result</th>
              <th className={HEAD}>Detail</th>
            </tr>
          </thead>
          <tbody className="ruled">
            {report.checks.map((check) => (
              <tr key={check.name}>
                <td className={`${CELL} whitespace-nowrap font-medium`}>
                  {check.name}
                </td>
                <td className={`${CELL} whitespace-nowrap`}>
                  {check.ok ? (
                    <span className="inline-flex items-center gap-1.5 text-good">
                      <CircleCheck className="size-4" aria-hidden /> ok
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-bad">
                      <CircleX className="size-4" aria-hidden /> failed
                    </span>
                  )}
                </td>
                <td className={CELL}>
                  <p>{check.message}</p>
                  {check.reason ? (
                    <p className="text-muted-foreground">{check.reason}</p>
                  ) : null}
                  {check.hint ? (
                    <p className="text-muted-foreground">{check.hint}</p>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.notices?.length ? (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {report.notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
