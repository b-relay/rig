import Link from "next/link";
import { FolderX } from "lucide-react";
import { Empty, Failure } from "@/components/bits";
import { CompletedOperation } from "@/components/completed-operation";
import { ProjectMatrix } from "@/components/project-matrix";
import { projectMatrix } from "@/lib/matrix";
import { projectHref } from "@/lib/target";
import { project } from "@/server/project";
import { projectStatus } from "@/server/status";
import { projectWork } from "@/server/work";

/** The Project's matrix: its Targets across the top with their actions, its Services, stores,
 * Tools and jobs down the side, a tile for each on each Target. */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ operation?: string | string[] }>;
}) {
  const found = await project(params);
  if (found.missing)
    return (
      <Empty icon={FolderX} title="Repository missing">
        The registered directory no longer exists.{" "}
        <Link href={`${projectHref(found.name)}/settings`}>
          Repoint or forget it
        </Link>
        .
      </Empty>
    );
  const [status, work, { operation }] = await Promise.all([
    projectStatus(found.name),
    projectWork(found.name),
    searchParams,
  ]);
  // On its own page a refusal is said in full: code, message, hint and Operation.
  if (!status.ok) return <Failure failure={status.failure} />;
  const matrix = projectMatrix({ project: found, status });
  return (
    <>
      <CompletedOperation operation={operation} project={found.name} />
      <ProjectMatrix
        matrix={matrix}
        work={work}
        now={Date.now()}
        corner="rows"
      />
    </>
  );
}
