import { createHash } from "node:crypto";
import type { ManagedComponent, TargetPlan } from "../config/types";

/* What a deploy compares to decide whether a running Service is unchanged (ADR 0016). Every Deployment runs from its own
 * checkout, so the checkout path differs between any two plans; it is replaced by a placeholder before anything is
 * compared, and the rest must match exactly. */

/** Stands for the checkout path in a definition or an environment. */
export const CHECKOUT_PLACEHOLDER = "${checkout}";

/** Pure: `text` with every occurrence of the checkout path `checkout` replaced by the placeholder. */
export function withoutCheckout(text: string, checkout: string): string {
  return checkout ? text.split(checkout).join(CHECKOUT_PLACEHOLDER) : text;
}

/** Pure: JSON with every object's keys in sorted order, so equal values give equal text whatever order they were built in.
 * Array order is kept: it means something (the order env files load in, say). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}

/** Pure: the SHA-256 of a Service's definition in `plan`, with the checkout path replaced by a placeholder: every setting
 * its plan records for it (command, working_dir, environment with references resolved, env file paths, ports,
 * depends_on, healthcheck, stop_timeout, restart), its own build unit and the Project's shared build. `watch` is not part
 * of it: it says what a deploy compares, and changing it changes nothing about the process. Two plans that give a Service
 * equal definitions start equal processes from their own checkouts. */
export function serviceDefinition(
  plan: Pick<TargetPlan, "workspacePath" | "builds">,
  component: ManagedComponent,
): string {
  const { watch: _watch, ...service } = component;
  const builds = (plan.builds ?? []).filter(
    (unit) =>
      unit.component === undefined || unit.id === `service:${service.name}`,
  );
  return createHash("sha256")
    .update(
      withoutCheckout(canonicalJson({ service, builds }), plan.workspacePath),
    )
    .digest("hex");
}

/** Pure: the text of a composed process environment that its keyed digest is taken of: every name and value, the checkout
 * path in values replaced by a placeholder. It holds values, so it is never stored or logged; only its digest is. */
export function environmentText(
  env: Readonly<Record<string, string>>,
  checkout: string,
): string {
  return canonicalJson(
    Object.fromEntries(
      Object.entries(env).map(([name, value]) => [
        name,
        withoutCheckout(value, checkout),
      ]),
    ),
  );
}
