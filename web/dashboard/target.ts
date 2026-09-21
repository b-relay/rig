import type { RuntimeCommand, TargetReport } from "./types";

/** How a command names a Target from a status report: a Preview by its deployment name, the others by their own. */
export function targetSelector(
  target: Pick<TargetReport, "kind" | "name">,
): Pick<RuntimeCommand, "target" | "deployment"> {
  return target.kind === "preview"
    ? { target: "preview", deployment: target.name }
    : { target: target.name };
}
/** The inverse for a `<select>`: one string per Target. */
export const targetKey = (target: Pick<TargetReport, "kind" | "name">) =>
  `${target.kind}:${target.name}`;
