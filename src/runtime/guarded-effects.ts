import type { RouteGuard } from "./route-guard";
import type { StopControl, TargetEffects } from "./lifecycle";

/** The effects an Operation under `stops` acts through: `effects` inside its route guard's exclusive section when it has
 * one, `effects` itself otherwise. */
export function effectsUnder(
  effects: TargetEffects,
): (stops: StopControl | undefined) => TargetEffects {
  return (stops) =>
    stops?.guard ? guardedEffects(effects, stops.guard) : effects;
}
/** `effects` with each route change of a stop or start, and each other write to the effect journal those changes share,
 * inside `guard`'s exclusive section, from its first read to the journal's final capture. A route withdrawn whole
 * (`withdrawRoute`) is a Target's that nothing watches. */
function guardedEffects(
  effects: TargetEffects,
  guard: RouteGuard,
): TargetEffects {
  return {
    ...effects,
    async checkpoint(target, previous) {
      const checkpoint = await guard.exclusive(() =>
        effects.checkpoint(target, previous),
      );
      return {
        targetId: checkpoint.targetId,
        commit: () => guard.exclusive(() => checkpoint.commit()),
        rollback: () =>
          guard.exclusive(async () => {
            await checkpoint.rollback();
            guard.publishedUnder(previous ?? target);
          }),
      };
    },
    restoreEffects: (target) =>
      guard.exclusive(() => effects.restoreEffects(target)),
    commitEffects: (target) =>
      guard.exclusive(() => effects.commitEffects(target)),
    retireSuperseded: (previous, candidate) =>
      guard.exclusive(() => effects.retireSuperseded(previous, candidate)),
    install: (component, target) =>
      guard.exclusive(() => effects.install(component, target)),
    route: (target, change) =>
      guard.exclusive(async () => {
        await effects.route(target, change);
        guard.publishedUnder(target);
        if ("withhold" in change) await guard.withheld(target, change.withhold);
      }),
    withhold: (target, ports) =>
      guard.exclusive(async () => {
        await effects.withhold(target, ports);
        await guard.withheld(target, ports);
      }),
    removeRoute: (target) => guard.exclusive(() => effects.removeRoute(target)),
  };
}
