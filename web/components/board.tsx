import Link from "next/link";
import { Suspense } from "react";
import { TriangleAlert } from "lucide-react";
import { boardRows, type ProjectNotice } from "@/lib/board-rows";
import { attempt } from "@/lib/outcome";
import type { ListResult } from "@/lib/types";
import { read } from "@/server/daemon";
import { TargetsTable } from "./targets-table";
import { cn } from "@/lib/utils";

type Project = ListResult["projects"][number];
/** Every Target on this Host in one data table. The table's frame shows at once; the rows
 * arrive together when every Project's status has, with anything wrong at Project level
 * said above the table. */
export function Board({
  projects,
  hideProject = false,
}: {
  projects: readonly Project[];
  hideProject?: boolean;
}) {
  return (
    <Suspense
      fallback={<TargetsTable rows={[]} hideProject={hideProject} loading />}
    >
      <BoardRows projects={projects} hideProject={hideProject} />
    </Suspense>
  );
}
async function BoardRows({
  projects,
  hideProject,
}: {
  projects: readonly Project[];
  hideProject: boolean;
}) {
  const entries = await Promise.all(
    projects.map(async (project) => ({
      project,
      ...(project.missing
        ? {}
        : {
            status: await attempt(
              read({ action: "status", project: project.name }),
            ),
          }),
    })),
  );
  const { rows, notices } = boardRows(entries);
  return (
    <>
      <Notices notices={notices} />
      <TargetsTable rows={rows} hideProject={hideProject} />
    </>
  );
}
function Notices({ notices }: { notices: readonly ProjectNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {notices.map((notice, index) => (
        <li
          key={index}
          className={cn(
            "flex items-start gap-1.5",
            notice.tone === "bad" ? "text-bad" : "text-warn",
          )}
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <Link href={notice.href} className="font-medium">
              {notice.project}
            </Link>
            : {notice.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
