import { notFound } from "next/navigation";
import type { ListResult } from "../lib/types";
import { projectList } from "./status";

export type Project = ListResult["projects"][number];
/** The registered Project a page is about, or the not-found page when this Host has none by that name.
 * A list rigd refused is thrown, so the page's error boundary says why. */
export async function project(
  params: Promise<{ name: string }>,
): Promise<Project> {
  const { name } = await params;
  const list = await projectList();
  if (!list.ok)
    throw Object.assign(new Error(list.failure.message), list.failure);
  const found = list.value.projects.find((each) => each.name === name);
  if (!found) notFound();
  return found;
}
