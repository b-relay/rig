"use client";

import {
  useEffect,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { own, scopeFile, scopeReaders } from "@/lib/env";
import {
  discard,
  drift,
  draftChanges,
  EMPTY_DRAFT,
  keepReveal,
  rebase,
  revealedValue,
  saveRequest,
  stage,
  beginEdit,
  keepEdit,
  type EnvDraft,
  type EnvEdit,
  type Pending,
} from "@/lib/env-draft";
import type { Failure as FailureShape, Outcome } from "@/lib/outcome";
import { transportFailure } from "@/lib/reconcile";
import { targetSelector } from "@/lib/target";
import type { EnvFileView, TargetReport } from "@/lib/types";
import { runEnvEdit } from "@/server/actions";
import { Failure, Mono, Notice, Warning } from "./bits";
import { useRun } from "./operations";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** A name an env file may assign; names starting with _RIG_ are reserved for Rig. */
const ENV_KEY = /^(?!_RIG_)[A-Za-z_][A-Za-z0-9_]*$/;
const MASK = "••••••••••••";
const LINE_BREAK = /[\r\n]/;
async function call(input: unknown): Promise<Outcome<unknown>> {
  try {
    return await runEnvEdit(input);
  } catch (error) {
    return { ok: false, failure: transportFailure(error) };
  }
}
/** One operator env file: its names with values masked until revealed, edited in place, and saved
 * together after a review that lists the names (never the values). Values are fetched one at a time
 * when asked for and live only in this component's memory. */
export function SecretsEditor({
  project,
  file,
  readers,
}: {
  project: string;
  file: EnvFileView;
  /** The Targets that read this file, which a saved change reaches on their next restart. */
  readers: readonly Pick<TargetReport, "name" | "kind" | "state">[];
}) {
  const router = useRouter();
  // Staged changes keep the file they were made against, and revealed values the revision they were read from, so a
  // refresh shows the current file without losing the draft or showing an old value as current.
  const [draft, setDraft] = useState<EnvDraft>(EMPTY_DRAFT);
  // An edit or a new name keeps the file shown when its typing began, which a Keep stages it against.
  const [editing, setEditing] = useState<EnvEdit>();
  const [adding, setAdding] = useState<{
    key: string;
    value: string;
    show: boolean;
    base?: EnvFileView;
  }>({ key: "", value: "", show: false });
  const [failure, setFailure] = useState<FailureShape>();
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // Each save counts up, so its restart controls start fresh: a restart answers only the save it followed.
  const [saved, setSaved] = useState<{
    keys: string[];
    warning?: string;
    generation: number;
  }>();
  // Staged values are masked like stored ones until shown; the edit field hides what is typed unless asked.
  const [visible, setVisible] = useState<Record<string, true>>({});
  const [editVisible, setEditVisible] = useState(false);
  // A value read from an older revision is masked at once (revealedValue); this drops it from memory too.
  useEffect(
    () =>
      setDraft((now) => ({
        ...now,
        revealed: Object.fromEntries(
          Object.entries(now.revealed).filter(
            ([, each]) => each.revision === file.revision,
          ),
        ),
      })),
    [file.revision],
  );
  const pending = draft.pending;
  const shownValue = (key: string) =>
    revealedValue(draft.revealed, key, file.scope, file.revision);
  const moved = drift(draft, file);
  const locked = file.problem !== undefined;
  // A name being edited stays until Keep or Cancel, even once another writer removed it, so what was typed is not lost.
  const keys = [
    ...new Set([
      ...file.keys,
      ...Object.keys(pending),
      ...(editing ? [editing.key] : []),
    ]),
  ];
  const changes = draftChanges(draft);
  const reveal = async (key: string) => {
    setFailure(undefined);
    const outcome = await call({
      action: "reveal",
      project,
      scope: file.scope,
      key,
    });
    if (!outcome.ok) {
      setFailure(outcome.failure);
      return;
    }
    const reply = outcome.value as { value: string; revision: string };
    if (reply.revision !== file.revision) {
      // The file moved since this page read it: read it again rather than show a value beside names it no longer has.
      setFailure({
        code: "ENV_FILE_CHANGED",
        message: `${scopeFile(file.scope)} changed since this page read it, so ${key} stays masked.`,
        hint: "The page reads it again now; reveal it again to see its current value.",
      });
      router.refresh();
      return;
    }
    setDraft((now) => ({
      ...now,
      revealed: keepReveal(now.revealed, key, file.scope, file.revision, reply),
    }));
  };
  const hide = (key: string) =>
    setDraft(({ revealed: { [key]: _gone, ...kept }, ...now }) => ({
      ...now,
      revealed: kept,
    }));
  const stageChange = (key: string, change: Pending | undefined) =>
    setDraft((now) => stage(now, file, key, change));
  const refuseLineBreaks = (what: string, outcome: string) =>
    setFailure({
      code: "ENV_VALUE",
      message: `${what} has line breaks, which this one-line field cannot keep, so ${outcome}.`,
      hint: `Edit ${file.path} in an editor instead, with each line break written as \\n in double quotes: NAME="first\\nsecond".`,
    });
  const refuseOffer = (
    event: { preventDefault(): void },
    data: Pick<DataTransfer, "getData">,
  ) => {
    if (!LINE_BREAK.test(data.getData("text"))) return;
    event.preventDefault();
    refuseLineBreaks("That text", "it was not put in");
  };
  /** A browser silently strips line breaks from what a one-line field is given, so what holds any never gets there. */
  const oneLine = {
    onPaste: (event: ClipboardEvent<HTMLInputElement>) =>
      refuseOffer(event, event.clipboardData),
    onDrop: (event: DragEvent<HTMLInputElement>) =>
      refuseOffer(event, event.dataTransfer),
  };
  const save = async () => {
    setBusy(true);
    setFailure(undefined);
    const outcome = await call(saveRequest(project, draft, file));
    setBusy(false);
    setReviewing(false);
    if (!outcome.ok) {
      // The draft stays: a conflict is shown with how the file differs once the page has read it again.
      setFailure(outcome.failure);
      if (outcome.failure.code === "ENV_REVISION_CONFLICT") router.refresh();
      return;
    }
    const warning = (outcome.value as { warning?: unknown }).warning;
    setSaved((before) => ({
      keys: changes.map((change) => change.key),
      ...(typeof warning === "string" ? { warning } : {}),
      generation: (before?.generation ?? 0) + 1,
    }));
    setVisible({});
    setDraft(EMPTY_DRAFT);
    router.refresh();
  };
  const newKeyProblem = !adding.key
    ? undefined
    : !ENV_KEY.test(adding.key)
      ? "A name has letters, digits and underscores, and does not start with a digit or _RIG_."
      : keys.includes(adding.key)
        ? `${adding.key} is already in this file; edit it above.`
        : undefined;
  const newKeyValid = adding.key !== "" && newKeyProblem === undefined;
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4 text-muted-foreground" aria-hidden />
            {scopeFile(file.scope)}
            {!file.exists ? (
              <span className="text-xs font-normal text-muted-foreground">
                not created yet
              </span>
            ) : null}
          </h2>
          <p className="text-xs text-muted-foreground">
            {scopeReaders(file.scope)} Values are masked until you reveal one.
          </p>
          <Mono className="text-muted-foreground">{file.path}</Mono>
        </div>
        {file.mode !== undefined && file.mode & 0o077 ? (
          <span className="rounded bg-warn-fill px-2 py-0.5 text-xs text-warn">
            mode {file.mode.toString(8)}: saving makes it 600
          </span>
        ) : null}
      </header>
      {locked ? (
        <div className="border-b p-4">
          <Notice tone="warn" title="This file cannot be edited here">
            {file.problem} Fix that line in an editor; the dashboard does not
            rewrite a file it cannot read.
          </Notice>
        </div>
      ) : null}
      {saved ? (
        <div className="border-b p-4">
          <Notice tone="good" title="Saved">
            <p>
              {saved.keys.join(", ")} {saved.keys.length === 1 ? "was" : "were"}{" "}
              written. Activity records the names, never the values.{" "}
              {file.scope.job
                ? `The ${file.scope.job} Job's next run or restore reads it; nothing needs a restart.`
                : "Processes read env files when they start, so restart what reads this file to apply it."}
            </p>
            {saved.warning ? (
              <p className="text-warn">{saved.warning}</p>
            ) : null}
            {file.scope.job ? null : (
              <RestartReaders
                key={saved.generation}
                project={project}
                readers={readers}
              />
            )}
          </Notice>
        </div>
      ) : null}
      {moved ? (
        <div className="border-b p-4">
          <Notice
            tone="warn"
            title={`${scopeFile(file.scope)} changed since you started editing`}
          >
            <p>
              {moved.added.length
                ? `It now also assigns ${moved.added.join(", ")}. `
                : ""}
              {moved.removed.length
                ? `It no longer assigns ${moved.removed.join(", ")}. `
                : ""}
              Any other value may have changed too; reveal one to see it now.
              Your {changes.length} unsaved{" "}
              {changes.length === 1 ? "change is" : "changes are"} kept, and
              nothing is saved over the newer file until you review{" "}
              {changes.length === 1 ? "it" : "them"} against it.
            </p>
          </Notice>
        </div>
      ) : null}
      {failure ? (
        <div className="border-b p-4">
          <Failure failure={failure} />
        </div>
      ) : null}
      <ul className="divide-y">
        {keys.length === 0 ? (
          <li className="px-4 py-6 text-sm text-muted-foreground">
            No variables yet. Add the first one below.
          </li>
        ) : null}
        {keys.map((key) => {
          const change = own(pending, key);
          const isNew = !file.keys.includes(key);
          const value =
            change?.op === "set"
              ? own(visible, key)
                ? change.value
                : undefined
              : shownValue(key);
          const shown = editing?.key === key;
          return (
            <li
              key={key}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2 sm:grid-cols-[minmax(10rem,16rem)_minmax(0,1fr)_auto]",
                change?.op === "remove" && "bg-bad-fill/40",
                change?.op === "set" && "bg-warn-fill/40",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Mono
                  className={cn(
                    "truncate text-[13px] text-foreground",
                    change?.op === "remove" && "line-through",
                  )}
                  title={key}
                >
                  {key}
                </Mono>
                {change ? (
                  <span
                    className={cn(
                      "text-[11px] font-medium",
                      change.op === "remove" ? "text-bad" : "text-warn",
                    )}
                  >
                    {change.op === "remove"
                      ? "removed"
                      : isNew
                        ? "new"
                        : "edited"}
                  </span>
                ) : isNew ? (
                  <span className="text-[11px] font-medium text-bad">
                    no longer in the file
                  </span>
                ) : null}
              </span>
              <div className="col-span-2 min-w-0 sm:order-none sm:col-span-1">
                {shown ? (
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setDraft((now) => keepEdit(now, editing, file));
                      setEditing(undefined);
                    }}
                  >
                    <Input
                      {...oneLine}
                      autoFocus
                      type={editVisible ? "text" : "password"}
                      value={editing.value}
                      onChange={(event) =>
                        setEditing({ ...editing, value: event.target.value })
                      }
                      aria-label={`New value for ${key}`}
                      placeholder={
                        shownValue(key) === undefined
                          ? "Type the new value"
                          : undefined
                      }
                      autoComplete="new-password"
                      spellCheck={false}
                      className="h-8 font-mono text-xs"
                    />
                    <IconButton
                      label={
                        editVisible
                          ? "Hide what you type"
                          : "Show what you type"
                      }
                      onClick={() => setEditVisible((now) => !now)}
                    >
                      {editVisible ? <EyeOff /> : <Eye />}
                    </IconButton>
                    <Button
                      type="submit"
                      size="sm"
                      className="h-8"
                      // An unrevealed value is never blanked by accident: keeping an empty field needs the old value seen.
                      disabled={
                        editing.value === "" && shownValue(key) === undefined
                      }
                    >
                      Keep
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8"
                      onClick={() => setEditing(undefined)}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <Mono
                    className={cn(
                      "block text-xs",
                      value === undefined
                        ? "tracking-widest text-muted-foreground"
                        : "break-all whitespace-pre-wrap text-foreground",
                    )}
                  >
                    {change?.op === "remove"
                      ? ""
                      : value === undefined
                        ? MASK
                        : value || "(empty)"}
                  </Mono>
                )}
              </div>
              <span className="row-start-1 flex items-center justify-end gap-0.5 sm:col-start-3">
                {change ? (
                  <>
                    {change.op === "set" ? (
                      <IconButton
                        label={
                          own(visible, key)
                            ? `Hide the new value of ${key}`
                            : `Show the new value of ${key}`
                        }
                        onClick={() =>
                          setVisible((now) => {
                            const { [key]: _shown, ...kept } = now;
                            return own(now, key)
                              ? kept
                              : { ...kept, [key]: true as const };
                          })
                        }
                      >
                        {own(visible, key) ? <EyeOff /> : <Eye />}
                      </IconButton>
                    ) : null}
                    <IconButton
                      label={`Undo the change to ${key}`}
                      onClick={() => stageChange(key, undefined)}
                    >
                      <Undo2 />
                    </IconButton>
                  </>
                ) : isNew ? null : (
                  <>
                    {shownValue(key) === undefined ? (
                      <IconButton
                        label={`Reveal ${key}`}
                        disabled={locked}
                        onClick={() => void reveal(key)}
                      >
                        <Eye />
                      </IconButton>
                    ) : (
                      <IconButton
                        label={`Hide ${key}`}
                        onClick={() => hide(key)}
                      >
                        <EyeOff />
                      </IconButton>
                    )}
                    <IconButton
                      label={`Edit ${key}`}
                      disabled={locked}
                      onClick={() => {
                        const held = shownValue(key);
                        if (held !== undefined && LINE_BREAK.test(held)) {
                          refuseLineBreaks(
                            `The value of ${key}`,
                            "it cannot be edited here",
                          );
                          return;
                        }
                        setEditVisible(held !== undefined);
                        setEditing(beginEdit(file, key, held ?? ""));
                      }}
                    >
                      <Pencil />
                    </IconButton>
                    <IconButton
                      label={`Remove ${key}`}
                      disabled={locked}
                      onClick={() => stageChange(key, { op: "remove" })}
                    >
                      <Trash2 />
                    </IconButton>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {locked ? null : (
        <form
          className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newKeyValid) return;
            const { key, value, base = file } = adding;
            setDraft((now) => keepEdit(now, { key, value, base }, file));
            setAdding({ key: "", value: "", show: false });
          }}
        >
          <Input
            value={adding.key}
            onChange={(event) =>
              setAdding((now) => ({
                ...now,
                key: event.target.value,
                base: now.base ?? file,
              }))
            }
            placeholder="NAME"
            aria-label="New variable name"
            aria-invalid={newKeyProblem !== undefined}
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-48 font-mono text-xs"
          />
          <div className="relative min-w-48 flex-1">
            <Input
              {...oneLine}
              value={adding.value}
              type={adding.show ? "text" : "password"}
              onChange={(event) =>
                setAdding((now) => ({
                  ...now,
                  value: event.target.value,
                  base: now.base ?? file,
                }))
              }
              placeholder="value"
              aria-label="New variable value"
              autoComplete="new-password"
              spellCheck={false}
              className="h-8 pr-9 font-mono text-xs"
            />
            <button
              type="button"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={adding.show ? "Hide the value" : "Show the value"}
              onClick={() => setAdding((now) => ({ ...now, show: !now.show }))}
            >
              {adding.show ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="h-8"
            disabled={!newKeyValid}
          >
            <Plus /> Add
          </Button>
          {newKeyProblem ? (
            <div role="status" className="basis-full">
              <Warning>{newKeyProblem}</Warning>
            </div>
          ) : null}
        </form>
      )}
      {changes.length ? (
        <footer className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
          <span className="text-sm">
            {changes.length} unsaved{" "}
            {changes.length === 1 ? "change" : "changes"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setDraft(discard)}
          >
            Discard
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              // Saving over a newer file is a choice made in this review, which lists the changes against it.
              if (moved) setDraft((now) => rebase(now, file));
              setReviewing(true);
            }}
          >
            {moved ? "Review against the current file" : "Review and save"}
          </Button>
        </footer>
      ) : null}
      <AlertDialog open={reviewing} onOpenChange={setReviewing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save {scopeFile(file.scope)}?</AlertDialogTitle>
            <AlertDialogDescription>
              rigd rewrites the file atomically, keeps its comments and order,
              and leaves it readable by you alone. Activity records these names,
              never their values.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex flex-col gap-1 text-sm">
            {changes.map((change) => (
              <li key={change.key} className="flex items-center gap-2">
                <span
                  className={cn(
                    "w-16 text-xs font-medium",
                    change.op === "remove" ? "text-bad" : "text-warn",
                  )}
                >
                  {change.op === "remove"
                    ? "remove"
                    : file.keys.includes(change.key)
                      ? "change"
                      : "add"}
                </span>
                <Mono className="text-[13px] text-foreground">
                  {change.key}
                </Mono>
                {change.op === "set" && change.value === "" ? (
                  <span className="text-xs text-warn">to an empty value</span>
                ) : null}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}
/** A Restart button for each running Target that reads the saved file. */
function RestartReaders({
  project,
  readers,
}: {
  project: string;
  readers: readonly Pick<TargetReport, "name" | "kind" | "state">[];
}) {
  const running = readers.filter(
    (target) => !["stopped", "configured"].includes(target.state),
  );
  if (!running.length) return <p>No Target that reads it is running now.</p>;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {running.map((target) => (
        <RestartButton key={target.name} project={project} target={target} />
      ))}
    </div>
  );
}
function RestartButton({
  project,
  target,
}: {
  project: string;
  target: Pick<TargetReport, "name" | "kind">;
}) {
  const act = useRun();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={act.busy || act.result !== undefined}
        onClick={() =>
          void act.run({
            action: "restart",
            project,
            ...targetSelector(target),
          })
        }
      >
        <RotateCw className={cn("size-3.5", act.busy && "animate-spin")} />
        {act.result ? `${target.name} restarted` : `Restart ${target.name}`}
      </Button>
      {act.failure ? (
        <span className="text-xs text-bad">{act.failure.message}</span>
      ) : null}
    </span>
  );
}
