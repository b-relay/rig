import { notFound } from "next/navigation";
import { attempt, type Outcome } from "../lib/outcome";
import type { ListResult } from "../lib/types";
import { read } from "./daemon";

export type Project = ListResult["projects"][number];
/** The registered Project a page is about, or the not-found page when this Host has none by that name. */
export async function project(
  params: Promise<{ name: string }>,
): Promise<Project> {
  const { name } = await params;
  const list = await read({ action: "list" });
  const found = (list as ListResult).projects.find(
    (each) => each.name === name,
  );
  if (!found) notFound();
  return found;
}
/** The same, as an outcome, for pages that should render even when rigd is down. */
export const projectOutcome = (
  params: Promise<{ name: string }>,
): Promise<Outcome<Project>> => attempt(project(params));
