import { cache } from "react";
import { attempt } from "../lib/outcome";
import { projectWork as workOf, type ProjectWork } from "../lib/target-work";
import { read } from "./daemon";

const queueNow = cache(() => attempt(read({ action: "queue" })));
/** What rigd is doing to each of a Project's Targets and how their last actions ended, read once per request. */
export const projectWork = cache(
  async (project: string): Promise<ProjectWork> => {
    const [queue, activity] = await Promise.all([
      queueNow(),
      attempt(read({ action: "activity", project, lines: 100 })),
    ]);
    return workOf(
      project,
      queue.ok ? queue.value : undefined,
      activity.ok ? activity.value : undefined,
    );
  },
);
