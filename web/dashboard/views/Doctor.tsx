import { CircleCheck, CircleX, RefreshCw } from "lucide-react";
import { useApi, useRead } from "../hooks";
import { Failure, Notice, Panel } from "../ui";
import { Button } from "@/components/ui/button";

export function DoctorView({ project }: { project?: string }) {
  const api = useApi();
  const report = useRead(
    (signal) =>
      api.command(
        { action: "doctor", ...(project ? { project } : {}) },
        signal,
      ),
    `doctor:${project ?? ""}`,
  );
  return (
    <Panel
      title={project ? "Doctor" : "Host doctor"}
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={report.reload}
          disabled={report.loading}
        >
          <RefreshCw className={report.loading ? "animate-spin" : ""} />
          {report.loading ? "Checking…" : "Run again"}
        </Button>
      }
    >
      <Failure error={report.error} />
      {report.data ? (
        <Notice tone={report.data.ok ? "good" : "warn"}>
          {report.data.ok ? "All checks passed." : "Some checks failed."}
          {report.data.note ? <p>{report.data.note}</p> : null}
        </Notice>
      ) : null}
      <ul className="flex flex-col divide-y">
        {report.data?.checks.map((check) => (
          <li key={check.name} className="flex gap-3 py-2 text-sm">
            {check.ok ? (
              <CircleCheck
                role="img"
                aria-label="passed"
                className="mt-0.5 size-4 shrink-0 text-good"
              />
            ) : (
              <CircleX
                role="img"
                aria-label="failed"
                className="mt-0.5 size-4 shrink-0 text-bad"
              />
            )}
            <div className="min-w-0">
              <span className="font-medium">{check.name}</span>{" "}
              <span>{check.message}</span>
              {check.hint ? (
                <p className="text-xs text-muted-foreground">{check.hint}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {report.data?.notices?.map((notice) => (
        <p key={notice} className="text-xs text-muted-foreground">
          {notice}
        </p>
      ))}
    </Panel>
  );
}
