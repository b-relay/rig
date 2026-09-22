import { Board } from "@/components/board";
import { project } from "@/server/project";

/** The Project's Targets: the same table as the board, for this Project alone. */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const found = await project(params);
  return <Board projects={[found]} showProjectRows={false} />;
}
