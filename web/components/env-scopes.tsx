import Link from "next/link";
import { scopeKey } from "@/lib/env";
import type { EnvFileView } from "@/lib/types";
import { cn } from "@/lib/utils";

const ROLE_LABEL = {
  all: "all Targets",
  working: "working",
  stable: "stable",
  preview: "Previews",
};
/** The operator env files of a Project as a list to choose from: the Project's files, then each
 * Service's, each for every Target and then per role, with how many names each holds. */
export function EnvScopes({
  base,
  services,
  files,
  selected,
}: {
  /** The page the choice is made on; the scope goes in its query. */
  base: string;
  services: readonly string[];
  files: readonly EnvFileView[];
  selected: string;
}) {
  const groups = [undefined, ...services];
  return (
    <nav
      aria-label="Env files"
      className="flex flex-col overflow-hidden rounded-lg border border-rule bg-sheet shadow-xs"
    >
      {groups.map((service) => (
        <div key={service ?? ""} className="border-b border-rule last:border-0">
          <div className="px-4 pt-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            {service ? `Service ${service}` : "Project"}
          </div>
          <ul className="flex flex-col pb-2">
            {files
              .filter((file) => file.scope.service === service)
              .map((file) => {
                const key = scopeKey(file.scope);
                const current = key === selected;
                return (
                  <li key={key}>
                    <Link
                      href={`${base}?scope=${encodeURIComponent(key)}`}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground no-underline hover:bg-muted hover:text-foreground",
                        current && "bg-muted font-medium text-foreground",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 rounded-full",
                          file.problem
                            ? "bg-bad"
                            : file.exists
                              ? "bg-good"
                              : "bg-rule",
                        )}
                      />
                      {ROLE_LABEL[file.scope.role ?? "all"]}
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {file.exists ? file.keys.length : "–"}
                      </span>
                    </Link>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
