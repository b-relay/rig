import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { Failure as FailureShape } from "@/lib/outcome";
import { toneOf } from "@/lib/present";
import type { OperationResult } from "@/lib/types";
import { shortCommit } from "@/lib/present";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Presentation pieces without state, usable from server and client components alike. */

/** A refusal or transport failure, with rigd's code and hint when it gave them. */
export function Failure({ failure }: { failure: FailureShape | undefined }) {
  if (!failure) return null;
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{failure.code}</AlertTitle>
      <AlertDescription>
        <p>{failure.message}</p>
        {failure.hint ? <p>{failure.hint}</p> : null}
        {failure.operationId ? (
          <p>
            <a
              href={`/activity?operation=${encodeURIComponent(failure.operationId)}`}
            >
              Operation{" "}
              <span className="font-mono text-xs">{failure.operationId}</span>
            </a>
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
type NoticeTone = "info" | "warn" | "good";
const NOTICE_ICON = { info: Info, warn: TriangleAlert, good: CircleCheck };
export function Notice({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const Icon = NOTICE_ICON[tone];
  return (
    <Alert
      className={cn(
        tone === "warn" && "border-warn/60 bg-warn-fill [&>svg]:text-warn",
        tone === "good" && "border-good/60 bg-good-fill [&>svg]:text-good",
        className,
      )}
    >
      <Icon />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
const DOT = {
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  busy: "bg-busy busy-dot",
  idle: "bg-muted-ink",
};
/** A lifecycle or outcome word with its colour dot. */
export function State({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", DOT[toneOf(value)])}
      />
      {value}
    </span>
  );
}
export function Field({
  label,
  help,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}
/** Label and value pairs in two columns. */
export function Facts({
  items,
}: {
  items: readonly (readonly [ReactNode, ReactNode] | undefined)[];
}) {
  const shown = items.filter(
    (item): item is readonly [ReactNode, ReactNode] => item !== undefined,
  );
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
      {shown.map(([label, value], index) => (
        <div key={index} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Mono({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={cn("font-mono text-xs break-all", className)}
      title={title}
    >
      {children}
    </span>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
/** A section of a page: a ruled heading and its content, no card around it. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-4", className)}>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-rule pb-2">
        <div className="min-w-0">
          <h2 className="title text-lg">{title}</h2>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
/** Grey bars standing in for text that has not arrived yet. */
export function Skeleton({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className={cn(
            "h-4 animate-pulse rounded bg-rule/60",
            index % 2 ? "w-1/2" : "w-3/4",
          )}
        />
      ))}
    </div>
  );
}
/** What a finished lifecycle, deploy or registration command reported. */
export function OperationNotice({
  result,
}: {
  result: OperationResult | undefined;
}) {
  if (!result) return null;
  return (
    <Notice tone={toneOf(result.outcome) === "good" ? "good" : "warn"}>
      <p>
        {[result.project, result.target, result.outcome]
          .filter(Boolean)
          .join(" ")}
        {result.commit ? `, ${shortCommit(result.commit)}` : ""}{" "}
        <a
          href={`/activity?operation=${encodeURIComponent(result.operationId)}`}
        >
          operation
        </a>
      </p>
      {result.warnings?.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </Notice>
  );
}
