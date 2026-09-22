import { notFound } from "next/navigation";
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
