import Link from "next/link";
import { Plus } from "lucide-react";
import { attempt } from "@/lib/outcome";
import type { ListResult } from "@/lib/types";
import { read } from "@/server/daemon";
import { Board } from "@/components/board";
import { Empty, Failure } from "@/components/bits";
import { Button } from "@/components/ui/button";

/** The root page: every Project and Target this Mac runs, in one table. */
export default async function BoardPage() {
  const list = await attempt(read({ action: "list" }));
  const projects = list.ok ? (list.value as ListResult).projects : [];
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="title text-2xl">Board</h1>
          <p className="text-sm text-muted-foreground">
            {list.ok
              ? `${projects.length} ${projects.length === 1 ? "Project" : "Projects"} on this Mac.`
              : "rigd did not answer."}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/projects/new">
            <Plus /> Add Project
          </Link>
        </Button>
      </div>
      {!list.ok ? <Failure failure={list.failure} /> : null}
      {list.ok && projects.length === 0 ? (
        <Empty>
          No Project is registered yet.{" "}
          <Link href="/projects/new">Add one</Link>, or run{" "}
          <code>rig init</code> in a repository.
        </Empty>
      ) : null}
      {projects.length > 0 ? <Board projects={projects} /> : null}
    </>
  );
}
