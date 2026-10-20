import { DEFAULT_STOP_TIMEOUT_SECONDS } from "../domain/stop-budget";
import type { PlanComponent, RestartPolicy, TargetPlan } from "./types";

/** When Rig starts a Service again after a known exit, when its config sets no `restart`. */
export const DEFAULT_RESTART_POLICY: RestartPolicy = "always";

/** A recorded plan with every field a later rigd added and a plan recorded before it lacks filled with the value the
 * planner gives when config does not set it: a managed Service's `stopTimeout` and `restart`. A plan recorded before such a
 * field existed then equals the plan the planner makes today from the same config; a value the plan did record is kept, so
 * a config that sets a non-default one still differs. The recorded plan is not changed. Add a field here whenever the
 * planner starts writing one that recorded plans may lack and whose absence means that default. */
export function withPlanDefaults(plan: TargetPlan): TargetPlan {
  return { ...plan, components: plan.components.map(withComponentDefaults) };
}
function withComponentDefaults(component: PlanComponent): PlanComponent {
  if (component.kind !== "managed") return component;
  return {
    ...component,
    stopTimeout: component.stopTimeout ?? DEFAULT_STOP_TIMEOUT_SECONDS,
    restart: component.restart ?? DEFAULT_RESTART_POLICY,
  };
}

const SHELL_SAFE = /^[A-Za-z0-9_/.:@%+=,-]+$/;
/** A reference's variable as Rig writes it: inside the author's single quotes, bare, or inside double quotes. */
const VARIABLE =
  /'"\$\{(_RIG_[A-Za-z0-9_]+)\}"'|"\$(_RIG_[A-Za-z0-9_]+)"|\$\{(_RIG_[A-Za-z0-9_]+)\}/g;
/** `command` with each variable that carries a reference's value written as the value, quoted as a rigd before reference
 * variables wrote it into the text: inside the author's single quotes escaped for them, inside double quotes escaped for
 * them, and bare single-quoted unless it needs no quoting. Only for comparing and reading, never for running. */
export function writtenCommand(
  command: string,
  values: Readonly<Record<string, string>> = {},
): string {
  return command.replace(
    VARIABLE,
    (match, single?: string, bare?: string, double?: string) => {
      const value = values[single ?? bare ?? double ?? ""];
      if (value === undefined) return match;
      if (double !== undefined) return value.replace(/[\\"$`]/g, "\\$&");
      const closed = value.replaceAll("'", "'\\''");
      if (single !== undefined) return closed;
      return SHELL_SAFE.test(value) ? value : `'${closed}'`;
    },
  );
}
/** `plan` with every shell command written with its values (see writtenCommand) and no `referenceValues`: the plan a rigd
 * before reference variables made from the same config, so a plan it recorded is no drift after an upgrade alone. */
export function withValuesWritten(plan: TargetPlan): TargetPlan {
  const { referenceValues: values = {}, ...rest } = plan;
  const write = (command: string) => writtenCommand(command, values);
  return {
    ...rest,
    components: plan.components.map((component) =>
      component.kind === "managed"
        ? {
            ...component,
            command: write(component.command),
            ...(component.health !== undefined
              ? { health: write(component.health) }
              : {}),
          }
        : component,
    ),
    ...(plan.builds
      ? {
          builds: plan.builds.map((unit) => ({
            ...unit,
            command: write(unit.command),
          })),
        }
      : {}),
    ...(plan.jobs
      ? {
          jobs: plan.jobs.map((job) => ({
            ...job,
            command: write(job.command),
            ...(job.backup?.restore !== undefined
              ? {
                  backup: { ...job.backup, restore: write(job.backup.restore) },
                }
              : {}),
          })),
        }
      : {}),
  };
}
