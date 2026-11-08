import type { TargetPlan } from "../config/types";
import type { TargetRecord } from "../domain/runtime";
import {
  RigError,
  failureCauses,
  failureReason as describedFailure,
} from "../domain/errors";
import type { Router } from "../providers/caddy-router";
import { liveUpstreams, parseOwnedSites } from "../providers/route-file";
import { routeUpstream, upstreamPort } from "../domain/route-upstream";
import { plannedSites } from "../runtime/ports";
import type { TargetEffects } from "../runtime/lifecycle";
import type { EffectTransactions } from "./target-artifacts";

/** A Target's route: its publication, withholding and withdrawal through the router. */
export type TargetRoutes = Pick<
  TargetEffects,
  | "livePorts"
  | "route"
  | "withhold"
  | "checkRoute"
  | "releaseRoute"
  | "removeRoute"
  | "withdrawRoute"
  | "pruneRoutes"
>;
/** Target routes published through `router`, every change journalled through `transactions`. */
export function createTargetRoutes(options: {
  router: Router;
  transactions: EffectTransactions;
}): TargetRoutes {
  const { router, transactions } = options;
  const livePorts = async (target: TargetRecord) =>
    new Set(
      [...liveUpstreams((await router.checkpoint(target.id)).value ?? "")].map(
        upstreamPort,
      ),
    );
  return {
    livePorts,
    async route(target, change) {
      const sites = plannedSites(target.plan);
      if (!sites.length)
        return transactions.withRouteChange(target.id, () =>
          router.remove(target.id),
        );
      if (sites.some((site) => !site.routes.length))
        throw new RigError(
          "ROUTE_UPSTREAM",
          "The route upstream is not a managed Component.",
          "Correct the Project proxy configuration.",
        );
      // A port is live while the route reaches it now, which it does only from its Service's verified start until just
      // before that Service stops; `withhold` takes ports out, `verified` adds them. Every path goes to its port's state,
      // so a path moved to another Service is live exactly when that Service's port is.
      const live = await livePorts(target);
      if ("withhold" in change)
        for (const port of change.withhold) live.delete(port);
      if ("verified" in change)
        for (const port of change.verified) live.add(port);
      await transactions.withRouteChange(target.id, () =>
        router.apply({
          key: target.id,
          sites: siteRoutes(target.plan, (port) =>
            live.has(port) ? routeUpstream(port) : null,
          ),
        }),
      );
    },
    async withhold(target, ports) {
      const saved = (await router.checkpoint(target.id)).value;
      const reaching = (upstream: string | null) =>
        upstream !== null && (!ports || ports.has(upstreamPort(upstream)));
      // Asked of the router even when the route file already withholds every such path: the file says what Rig meant to
      // publish, and only the router confirms what the proxy serves (a publication a crash cut short is made now).
      await transactions.withRouteChange(target.id, () =>
        saved === null
          ? router.remove(target.id)
          : router.apply({
              key: target.id,
              sites: parseOwnedSites(saved).map((site) => ({
                hostname: site.hostname,
                routes: site.routes.map((path) =>
                  reaching(path.upstream) ? { ...path, upstream: null } : path,
                ),
              })),
            }),
      );
    },
    async checkRoute(target) {
      // Asked even for a route-free plan: the router reserves the hostnames the Target serves now, which a rollback restores.
      const sites = siteRoutes(target.plan, routeUpstream);
      if (!router.check) return;
      await router.check({ key: target.id, sites });
    },
    async releaseRoute(target) {
      await router.release?.(target.id);
    },
    async removeRoute(target) {
      await transactions.withRouteChange(target.id, () =>
        router.remove(target.id),
      );
    },
    async withdrawRoute(target) {
      const saved = await router.checkpoint(target.id);
      // A Target that publishes nothing asks nothing of the proxy.
      if (saved.value === null) return undefined;
      // Once removed, the route as it is is known without reading it again: absent.
      const expected = { key: target.id, value: null };
      const hostnames = parseOwnedSites(saved.value).map(
        (site) => site.hostname,
      );
      try {
        await transactions.withRouteChange(target.id, () =>
          router.remove(target.id),
        );
      } catch (error) {
        // ROUTE_CHANGED: the route file was swapped for another file meanwhile, which a compensation reading it now
        // would write into. It is not compensated; its error says routes may be partly applied (ADR 0014, Threat model).
        if (error instanceof RigError && error.code === "ROUTE_CHANGED")
          throw error;
        // A failure after the removal took effect (recording it in an active effect journal, say) must not leave it
        // uncompensated: when the block is gone, or that cannot be read, it is published again before the failure is.
        const inPlace = async () =>
          (
            await router
              .checkpoint(target.id)
              .catch(() => ({ value: undefined }))
          ).value === saved.value;
        if (await inPlace()) throw error;
        try {
          await router.restore(saved, expected);
        } catch (recovery) {
          // Refused because the removal never happened after all (ROUTE_CHANGED): the route is where it was.
          if (await inPlace()) throw error;
          throw new RigError(
            "WITHDRAW_ROLLBACK",
            `The route for ${hostnames.join(", ")} was withdrawn, a failure followed (${describedFailure(error)}), and it could not be published again.`,
            `Its Target is stopped, so nothing was served through it; rig up or rig deploy of ${target.name} publishes its route again.`,
            { hostnames, target: target.name },
            failureCauses(error, recovery),
          );
        }
        throw error;
      }
      // Nothing that can fail runs between the confirmed removal and the handle that puts it back.
      return {
        hostnames,
        restore: () => router.restore(saved, expected),
      };
    },
    pruneRoutes: (owners, confinement) =>
      router.withdrawUnowned(owners, confinement),
  };
}
/** The sites `plan` serves, each path's upstream the one `upstream` gives its port (null withholds it). */
export function siteRoutes(
  plan: TargetPlan,
  upstream: (port: number) => string | null,
) {
  return plannedSites(plan).map((site) => ({
    hostname: site.hostname,
    routes: site.routes.map((route) => ({
      prefix: route.prefix,
      upstream: upstream(route.port),
    })),
  }));
}
