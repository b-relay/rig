import { notFound } from "next/navigation";
import type { ProjectStatusReport, TargetReport } from "../lib/types";
import { project, type Project } from "./project";
import { projectStatus } from "./status";

/** The Target a page is about, with its Project and the Project's whole status, or the not-found
 * page when the Project lists no Target by that name. A status rigd refused is thrown, so the
 * page's error boundary says why. */
export async function target(
  params: Promise<{ name: string; target: string }>,
): Promise<{
  project: Project;
  status: ProjectStatusReport;
  target: TargetReport;
}> {
  const { target: name } = await params;
  const found = await project(params);
  const status = await projectStatus(found.name);
  if (!status.ok)
    throw Object.assign(new Error(status.failure.message), status.failure);
  const report = status.value.targets.find(
    (each) => each.name === decodeURIComponent(name),
  );
  if (!report) notFound();
  return { project: found, status: status.value, target: report };
}
