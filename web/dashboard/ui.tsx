import { cloneElement, type ReactElement, type ReactNode } from "react";
import { CircleAlert, Info, TriangleAlert, CircleCheck } from "lucide-react";
import { RigdError } from "./api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** A refusal or transport failure, with rigd's code and hint when it gave them. */
export function Failure({ error }: { error: unknown }) {
  if (!error) return null;
  const known = error instanceof RigdError ? error : undefined;
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{known?.code ?? "ERROR"}</AlertTitle>
      <AlertDescription>
        <p>{error instanceof Error ? error.message : String(error)}</p>
        {known?.hint ? <p>{known.hint}</p> : null}
        {known?.operationId ? (
          <p className="font-mono text-xs">Operation {known.operationId}</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
type Tone = "info" | "warn" | "good";
const NOTICE_ICON = { info: Info, warn: TriangleAlert, good: CircleCheck };
export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: Tone;
  title?: ReactNode;
  children: ReactNode;
}) {
  const Icon = NOTICE_ICON[tone];
  return (
    <Alert
      className={cn(
        tone === "warn" && "border-warn/60 [&>svg]:text-warn",
        tone === "good" && "border-good/60 [&>svg]:text-good",
      )}
    >
      <Icon />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
const TONE: Record<string, string> = {
  healthy: "bg-good",
  running: "bg-good",
  ready: "bg-good",
  installed: "bg-good",
  succeeded: "bg-good",
  starting: "bg-busy",
  configured: "bg-muted-foreground",
  stopped: "bg-muted-foreground",
  unknown: "bg-warn",
  degraded: "bg-warn",
  unhealthy: "bg-bad",
  failed: "bg-bad",
  missing: "bg-bad",
};
/** A lifecycle or outcome word with its colour dot; unknown words read as idle. */
export function State({ value }: { value: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          TONE[value] ?? "bg-muted-foreground",
        )}
      />
      {value}
    </Badge>
  );
}
export function Panel({
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
    <Card className={cn("gap-4 py-5", className)}>
      <CardHeader className="px-5">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {title}
        </CardTitle>
        {description ? (
          // Beside the actions a long path wraps letter by letter on a phone, so it drops below them there.
          <CardDescription className="col-span-full sm:col-span-1">
            {description}
          </CardDescription>
        ) : null}
        {actions ? (
          // On a phone the actions take their own row so the title keeps its width.
          <CardAction className="col-start-1 col-end-3 row-start-auto flex flex-wrap justify-end gap-2 sm:col-start-2 sm:row-start-1">
            {actions}
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5">{children}</CardContent>
    </Card>
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
/** Label and value pairs that wrap into columns as the width allows. */
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
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
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
/** Wraps a trigger button in a confirmation when `when` holds; otherwise the trigger acts at once. */
export function Confirm({
  when = true,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  children,
}: {
  when?: boolean;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm(): void;
  children: ReactElement<{ onClick?: () => void }>;
}) {
  if (!when) return cloneElement(children, { onClick: onConfirm });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            variant={destructive ? "destructive" : "default"}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
export const when = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};
export const short = (commit: string | undefined) => commit?.slice(0, 10);
