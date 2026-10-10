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
const PILL = {
  good: "bg-good-fill text-good",
  warn: "bg-warn-fill text-warn",
  bad: "bg-bad-fill text-bad",
  busy: "bg-link/10 text-link",
  idle: "bg-muted text-muted-foreground ring-1 ring-inset ring-rule",
};
/** A lifecycle or outcome word as a tinted pill, for headers and cards where it must stand out. */
export function StatePill({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const tone = toneOf(value);
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap",
        PILL[tone],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-current",
          tone === "busy" && "busy-dot",
        )}
      />
      {value}
    </span>
  );
}
/** A small coloured dot standing for a state, with the word for screen readers. */
export function Dot({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        DOT[toneOf(value)],
        className,
      )}
      title={value}
    >
      <span className="sr-only">{value}</span>
    </span>
  );
}
const KIND_CLASS = {
  working: "text-muted-foreground ring-rule",
  stable: "text-ink ring-ink/30",
  preview: "text-link ring-link/30",
};
/** The Target role, as a quiet outlined tag. */
export function KindTag({
  kind,
  className,
}: {
  kind: "working" | "stable" | "preview";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded px-1.5 text-[11px] font-medium tracking-wide uppercase ring-1 ring-inset",
        KIND_CLASS[kind],
        className,
      )}
    >
      {kind}
    </span>
  );
}
export function Field({
  label,
  help,
  htmlFor,
  children,
  className,
  issues,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  /** What validation found wrong with this field, shown in red beneath it. */
  issues?: readonly string[];
}) {
  return (
    <div
      className={cn("grid gap-1.5", className)}
      data-invalid={issues?.length ? true : undefined}
    >
      <Label
        htmlFor={htmlFor}
        className={issues?.length ? "text-bad" : undefined}
      >
        {label}
      </Label>
      <div
        className={
          issues?.length
            ? "rounded-md [&_input]:border-bad [&_button[role=combobox]]:border-bad [&_textarea]:border-bad"
            : undefined
        }
      >
        {children}
      </div>
      {issues?.map((issue) => (
        <p key={issue} role="alert" className="text-xs text-bad">
          {issue}
        </p>
      ))}
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
/** The top of a page: its title, a line about it, and the page's own actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A small line above the title, such as the Project a Target belongs to. */
  eyebrow?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? (
          <div className="text-xs text-muted-foreground">{eyebrow}</div>
        ) : null}
        <h1 className="title text-2xl leading-tight">{title}</h1>
        {description ? (
          <div className="text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
/** A bordered surface for one group of content, with an optional titled header. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  flush = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** The content reaches the panel's edges, as a table does. */
  flush?: boolean;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border border-rule bg-sheet shadow-xs",
        className,
      )}
    >
      {title ? (
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description ? (
              <p className="text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </header>
      ) : null}
      <div className={flush ? undefined : "p-4"}>{children}</div>
    </section>
  );
}
/** One number with its label, for a page's summary row. */
export function Stat({
  label,
  value,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "good" | "bad" | "warn";
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-rule bg-sheet px-4 py-3 shadow-xs">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-2xl font-semibold tabular-nums",
          tone === "good" && "text-good",
          tone === "bad" && "text-bad",
          tone === "warn" && "text-warn",
        )}
      >
        {value}
      </span>
    </div>
  );
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
