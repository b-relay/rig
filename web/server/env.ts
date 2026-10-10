import { cache } from "react";
import { attempt, type Outcome } from "../lib/outcome";
import type { EnvFiles } from "../lib/types";
import { editEnv } from "./daemon";

/** Every operator env file of a Project, by name and revision only, read once per request. No value
 * is part of a page; one is fetched only when an operator reveals it. */
export const envFiles = cache((project: string): Promise<Outcome<EnvFiles>> =>
  attempt(editEnv({ action: "read", project }) as Promise<EnvFiles>),
);
