import type { ReactNode } from "react";
import {
  CircleAlert,
  CircleCheck,
  GitBranch,
  Info,
  TriangleAlert,
} from "lucide-react";
import { HEALTH_WORD, healthOf, type Health } from "@/lib/health";
import type { Failure as FailureShape } from "@/lib/outcome";
import { shortCommit, toneOf } from "@/lib/present";
import type { OperationResult, TargetReport } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Presentation pieces without state, usable from server and client components alike. Every page
 * is built from the same few: a card (`CARD`), a state dot, a tinted tile, and quiet type. */

/** The one surface: a rounded card with a hairline border and the faintest shadow. */
export const CARD = "rounded-xl border bg-card text-card-foreground shadow-xs";
/** A small heading over a group, as the sidebar and the matrix corner name theirs. */
export const EYEBROW =
  "text-[11px] font-medium tracking-wider text-idle uppercase";
/** Each health as a dot. */
export const HEALTH_DOT: Record<Health, string> = {
  green: "bg-good",
  orange: "bg-warn",
  red: "bg-bad",
  gray: "bg-idle",
};
/** Each health as a tinted tile and the text on it. */
export const HEALTH_TILE: Record<Health, string> = {
  green: "bg-good-fill text-good",
  orange: "bg-warn-fill text-warn",
  red: "bg-bad-fill text-bad",
  gray: "bg-muted text-idle",
};

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
              className="text-current underline"
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
        tone === "warn" &&
          "border-warn/30 bg-warn-fill text-warn [&>svg]:text-warn *:data-[slot=alert-description]:text-warn/90",
        tone === "good" &&
          "border-good/30 bg-good-fill text-good [&>svg]:text-good *:data-[slot=alert-description]:text-good/90",
        className,
      )}
    >
      <Icon />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
/** A quiet line about something wrong, for the foot of a card or above a page's content. */
export function Warning({
  tone = "warn",
  children,
  className,
}: {
  tone?: "warn" | "bad";
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex gap-2 text-xs leading-5",
        tone === "bad" ? "text-bad" : "text-warn",
        className,
      )}
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
/** A small dot standing for a state, with the word for screen readers and in the tooltip. A Target
 * that has never run is an empty ring. */
export function Dot({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const health = healthOf(value);
  return (
    <span
      role="img"
      aria-label={value}
      title={value}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        value === "configured" ? "border border-idle" : HEALTH_DOT[health],
        toneOf(value) === "busy" && "busy-dot",
        className,
      )}
    />
  );
}
/** A health of its own (not a state word) as a dot, for a Project or a group. */
export function HealthDot({
  health,
  className,
}: {
  health: Health;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={HEALTH_WORD[health]}
      title={HEALTH_WORD[health]}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        HEALTH_DOT[health],
        className,
      )}
    />
  );
}
/** A lifecycle or outcome word with its dot. */
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
      <Dot value={value} className="size-1.5" />
      {value}
    </span>
  );
}
/** A lifecycle or outcome word as a small tinted tile, for headers and cards where it must stand out. */
export function StatePill({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const health = healthOf(value);
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium whitespace-nowrap",
        HEALTH_TILE[health],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          HEALTH_DOT[health],
          toneOf(value) === "busy" && "busy-dot",
        )}
      />
      {value}
    </span>
  );
}
/** The Target role, as a quiet tag. */
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
        "inline-flex h-5 items-center rounded-md border px-1.5 text-[11px] font-medium text-muted-foreground",
        className,
      )}
    >
      {kind}
    </span>
  );
}
/** Where a Target's code comes from: `branch @ commit`, or the working copy. */
export function Revision({
  target,
  className,
}: {
  target: Pick<TargetReport, "kind" | "branch" | "commit">;
  className?: string;
}) {
  const sha = shortCommit(target.commit)?.slice(0, 7);
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
      title={[target.branch, target.commit].filter(Boolean).join(" @ ")}
    >
      <GitBranch className="size-3.5 shrink-0" aria-hidden />
      {target.kind === "working" && !target.branch ? (
        <span className="truncate">working copy</span>
      ) : !target.branch && !sha ? (
        <span className="truncate">not deployed</span>
      ) : (
        <span className="truncate font-mono">
          {target.branch ?? "no branch"}
          {sha ? <span className="text-foreground"> @ {sha}</span> : null}
        </span>
      )}
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
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
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
/** Nothing to show yet: a dashed outline, as the matrix marks a combination that does not exist,
 * with an optional icon and a way forward. */
export function Empty({
  children,
  icon: Icon,
  title,
  className,
}: {
  children: ReactNode;
  icon?: typeof Info;
  title?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-2 rounded-xl border border-dashed px-5 py-6 text-sm text-muted-foreground",
        className,
      )}
    >
      {Icon ? <Icon className="size-5" aria-hidden /> : null}
      {title ? (
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      ) : null}
      <div className="max-w-2xl leading-relaxed">{children}</div>
    </div>
  );
}
/** The top of a page: its title, a line about it, and the page's own actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A small line above the title, such as the Project a Target belongs to. */
  eyebrow?: ReactNode;
  /** A mark before the title, such as a Project's icon. */
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 items-center gap-3.5">
        {icon}
        <div className="flex min-w-0 flex-col gap-0.5">
          {eyebrow ? (
            <div className="text-xs text-muted-foreground">{eyebrow}</div>
          ) : null}
          <h1 className="text-xl leading-tight font-semibold tracking-tight sm:text-2xl">
            {title}
          </h1>
          {description ? (
            <div className="text-sm text-muted-foreground">{description}</div>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
/** A card for one group of content, with an optional titled header. */
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
  /** The content reaches the card's edges, as a list does. */
  flush?: boolean;
}) {
  return (
    <section
      className={cn("flex min-w-0 flex-col overflow-hidden", CARD, className)}
    >
      {title ? (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3.5 pb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </header>
      ) : null}
      <div
        className={cn(
          flush ? undefined : "p-4",
          title && !flush && "pt-0",
          title && flush && "border-t",
        )}
      >
        {children}
      </div>
    </section>
  );
}
/** One number with its label, as a small card in a page's summary row. */
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
    <div className={cn("flex flex-col gap-1 px-4 py-3", CARD)}>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {tone ? (
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              tone === "good" && "bg-good",
              tone === "bad" && "bg-bad",
              tone === "warn" && "bg-warn",
            )}
          />
        ) : null}
        {label}
      </span>
      <span className="text-xl font-semibold tracking-tight tabular-nums">
        {value}
      </span>
    </div>
  );
}
/** A section of a page: a small heading and its content in a card. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  tone,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** `danger` marks a section whose action cannot be undone. */
  tone?: "danger";
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 p-4 sm:p-5",
        CARD,
        tone === "danger" && "border-bad/30",
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2
            className={cn(
              "text-sm font-semibold",
              tone === "danger" && "text-bad",
            )}
          >
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
              {description}
            </p>
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
            "h-4 animate-pulse rounded-md bg-muted",
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
          className="text-current underline"
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
