import { cache } from "react";
import { attempt, type Outcome } from "../lib/outcome";
import type { ListResult, ProjectStatusReport } from "../lib/types";
import { read } from "./daemon";

/** The Projects this Host has registered, read once per request however many parts of the page ask. */
export const projectList = cache((): Promise<Outcome<ListResult>> =>
  attempt(read({ action: "list" })),
);
/** One Project's status, read once per request: the sidebar and the page share the observation
 * rather than each paying rigd's two-second budget. */
export const projectStatus = cache(
  (project: string): Promise<Outcome<ProjectStatusReport>> =>
    attempt(read({ action: "status", project })),
);
