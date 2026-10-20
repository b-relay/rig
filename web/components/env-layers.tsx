"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { scopeFile, scopeKey, type LayeredKey } from "@/lib/env";
import {
  currentReveals,
  keepReveal,
  revealedValue,
  type Revealed,
} from "@/lib/env-draft";
import type { Failure as FailureShape } from "@/lib/outcome";
import { transportFailure } from "@/lib/reconcile";
import { runEnvEdit } from "@/server/actions";
import { Failure, Mono } from "./bits";

/** The names one Service or Job of a Target gets from the operator env files, each with the file that wins
 * and the files it overrides. A value is masked until revealed, and fetched only then. */
export function EnvLayers({
  project,
  title,
  keys,
  editBase,
}: {
  project: string;
  title: string;
  keys: readonly LayeredKey[];
  /** The Project's Environment page; each file links to it with that file chosen. */
  editBase: string;
}) {
  const router = useRouter();
  // Each value is shown only while the file that wins still is the one, at the revision, it was read from.
  const [revealed, setRevealed] = useState<Record<string, Revealed>>({});
  const [failure, setFailure] = useState<FailureShape>();
  const shown = (entry: LayeredKey) =>
    revealedValue(revealed, entry.key, entry.from, entry.revision);
  // A value masked by a refresh is dropped from memory too; `layers` changes exactly when a key's file or revision does.
  const layers = keys
    .map((entry) => `${entry.key}=${scopeKey(entry.from)}@${entry.revision}`)
    .join("\n");
  useEffect(() => setRevealed((now) => currentReveals(now, keys)), [layers]);
  const reveal = async (entry: LayeredKey) => {
    setFailure(undefined);
    try {
      const outcome = await runEnvEdit({
        action: "reveal",
        project,
        scope: entry.from,
        key: entry.key,
      });
      if (!outcome.ok) {
        setFailure(outcome.failure);
        return;
      }
      const reply = outcome.value as { value: string; revision: string };
      if (reply.revision !== entry.revision) {
        setFailure({
          code: "ENV_FILE_CHANGED",
          message: `${scopeFile(entry.from)} changed since this page read it, so ${entry.key} stays masked.`,
          hint: "The page reads the files again now; reveal it again to see its current value and where it comes from.",
        });
        router.refresh();
        return;
      }
      setRevealed((now) =>
        keepReveal(now, entry.key, entry.from, entry.revision, reply),
      );
    } catch (error) {
      setFailure(transportFailure(error));
    }
  };
  const fileLink = (scope: LayeredKey["from"]) => (
    <Link
      href={`${editBase}?scope=${encodeURIComponent(scopeKey(scope))}`}
      className="font-mono text-xs"
    >
      {scopeFile(scope)}
    </Link>
  );
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
      <header className="border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
      </header>
      {failure ? (
        <div className="border-b p-3">
          <Failure failure={failure} />
        </div>
      ) : null}
      {keys.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          No operator env file assigns anything here.
        </p>
      ) : (
        <ul className="divide-y">
          {keys.map((entry) => (
            <li
              key={entry.key}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2 md:grid-cols-[minmax(9rem,14rem)_minmax(0,1fr)_minmax(8rem,auto)_auto]"
            >
              <Mono
                className="truncate text-[13px] text-foreground"
                title={entry.key}
              >
                {entry.key}
              </Mono>
              <Mono
                className={
                  shown(entry) === undefined
                    ? "col-span-2 tracking-widest text-muted-foreground md:col-span-1"
                    : "col-span-2 break-all whitespace-pre-wrap text-foreground md:col-span-1"
                }
              >
                {shown(entry) === undefined
                  ? "••••••••••••"
                  : shown(entry) || "(empty)"}
              </Mono>
              <span className="text-xs text-muted-foreground">
                from {fileLink(entry.from)}
                {entry.shadows.length ? (
                  <span className="block">
                    overrides{" "}
                    {entry.shadows.map((scope, index) => (
                      <span key={scopeKey(scope)}>
                        {index ? ", " : ""}
                        {fileLink(scope)}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="row-start-1 inline-flex size-7 items-center justify-center justify-self-end rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:col-start-4"
                aria-label={
                  shown(entry) === undefined
                    ? `Reveal ${entry.key}`
                    : `Hide ${entry.key}`
                }
                title={
                  shown(entry) === undefined
                    ? `Reveal ${entry.key}`
                    : `Hide ${entry.key}`
                }
                onClick={() =>
                  shown(entry) === undefined
                    ? void reveal(entry)
                    : setRevealed(({ [entry.key]: _gone, ...kept }) => kept)
                }
              >
                {shown(entry) === undefined ? (
                  <Eye className="size-3.5" />
                ) : (
                  <EyeOff className="size-3.5" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
