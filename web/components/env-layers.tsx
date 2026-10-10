"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { scopeFile, scopeKey, type LayeredKey } from "@/lib/env";
import type { Failure as FailureShape } from "@/lib/outcome";
import { transportFailure } from "@/lib/reconcile";
import { runEnvEdit } from "@/server/actions";
import { Failure, Mono } from "./bits";

/** The names one Service of a Target gets from the operator env files, each with the file that wins
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
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<FailureShape>();
  const reveal = async (entry: LayeredKey) => {
    setFailure(undefined);
    try {
      const outcome = await runEnvEdit({
        action: "reveal",
        project,
        scope: entry.from,
        key: entry.key,
      });
      if (outcome.ok)
        setRevealed((now) => ({
          ...now,
          [entry.key]: (outcome.value as { value: string }).value,
        }));
      else setFailure(outcome.failure);
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
    <section className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-rule bg-sheet shadow-xs">
      <header className="border-b border-rule px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
      </header>
      {failure ? (
        <div className="border-b border-rule p-3">
          <Failure failure={failure} />
        </div>
      ) : null}
      {keys.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          No operator env file assigns anything here.
        </p>
      ) : (
        <ul className="divide-y divide-rule/70">
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
                  revealed[entry.key] === undefined
                    ? "col-span-2 tracking-widest text-muted-foreground md:col-span-1"
                    : "col-span-2 break-all whitespace-pre-wrap text-foreground md:col-span-1"
                }
              >
                {revealed[entry.key] === undefined
                  ? "••••••••••••"
                  : revealed[entry.key] || "(empty)"}
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
                  revealed[entry.key] === undefined
                    ? `Reveal ${entry.key}`
                    : `Hide ${entry.key}`
                }
                title={
                  revealed[entry.key] === undefined
                    ? `Reveal ${entry.key}`
                    : `Hide ${entry.key}`
                }
                onClick={() =>
                  revealed[entry.key] === undefined
                    ? void reveal(entry)
                    : setRevealed(({ [entry.key]: _gone, ...kept }) => kept)
                }
              >
                {revealed[entry.key] === undefined ? (
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
