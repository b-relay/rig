import { cache } from "react";
import { attempt } from "../lib/outcome";
import { projectWork as workOf, type ProjectWork } from "../lib/target-work";
import { read } from "./daemon";
import { pagePulse } from "./pulse";

/** What rigd is doing to each of a Project's Targets and how their last actions ended, read once per request: the queue
 * is the page's pulse reading, and the Project's own Activity its own read, since the pulse keeps only the Host's newest. */
export const projectWork = cache(
  async (project: string): Promise<ProjectWork> => {
    const [{ readings }, activity] = await Promise.all([
      pagePulse(),
      attempt(read({ action: "activity", project, lines: 100 })),
    ]);
    return workOf(
      project,
      readings.queue.ok ? readings.queue.value : undefined,
      activity.ok ? activity.value : undefined,
    );
  },
);
