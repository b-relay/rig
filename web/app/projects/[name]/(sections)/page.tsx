import Link from "next/link";
import { FolderX } from "lucide-react";
import { Empty } from "@/components/bits";
import { ProjectMatrix } from "@/components/project-matrix";
import { projectMatrix } from "@/lib/matrix";
import { projectHref } from "@/lib/target";
import { project } from "@/server/project";
import { projectStatus } from "@/server/status";

/** The Project's matrix: its Targets across the top with their actions, its Services, stores,
 * Tools and jobs down the side, a tile for each on each Target. */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ name: string }>;
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
  const matrix = projectMatrix({
    project: found,
    status: await projectStatus(found.name),
  });
  return <ProjectMatrix matrix={matrix} now={Date.now()} corner="rows" />;
}
