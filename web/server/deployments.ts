import { cache } from "react";
import { attempt, type Outcome } from "../lib/outcome";
import type { DeploymentsResult } from "../lib/types";
import { read } from "./daemon";

/** A Project's recorded deploys, oldest first, read once per request. */
export const deploymentHistory = cache(
  (project: string): Promise<Outcome<DeploymentsResult>> =>
    attempt(read({ action: "deployments", project, lines: 200 })),
);
