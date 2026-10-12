import { join } from "node:path";
import { WORKING_TOOL_SUFFIX } from "../config/schema";
import type { InstalledComponent } from "../config/types";
import type { TargetRecord } from "./runtime";
/** Where `target` publishes the Tool `component` under the Rig root `root`: the stable Target owns the plain command, the
 * working Target `<tool>-dev`, and a Preview `<tool>-<preview name>`; a Tool published under a name from before Target names
 * were fixed keeps it (`publishedAs`). Pure. */
export function installedPath(
  root: string,
  target: Pick<TargetRecord, "kind" | "name">,
  component: Pick<InstalledComponent, "name" | "installName" | "publishedAs">,
): string {
  const suffix =
    target.kind === "stable"
      ? ""
      : `-${target.kind === "working" ? WORKING_TOOL_SUFFIX : target.name}`;
  return join(
    root,
    "bin",
    component.publishedAs ??
      `${component.installName ?? component.name}${suffix}`,
  );
}
