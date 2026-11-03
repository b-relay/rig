import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { HostnameCheck } from "@/lib/types";

/** The real row, rendered as the server sends it, with a repair that already succeeded on an earlier check. Only `useRun`'s
 * result is set, since a static render cannot click; without one the real hook answers as it does. */
const real = { ...(await import("./operations")) };
let earlier: unknown;
mock.module("./operations", () => ({
  ...real,
  useRun: (options?: { refresh?: boolean }) => ({
    ...real.useRun(options),
    ...(earlier === undefined ? {} : { result: earlier }),
  }),
}));
const { HostnameRow } = await import("./dns-hostnames");

const render = (check: HostnameCheck) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider
      value={
        {
          back() {},
          forward() {},
          refresh() {},
          push() {},
          replace() {},
          prefetch() {},
        } as never
      }
    >
      <HostnameRow check={check} />
    </AppRouterContext.Provider>,
  );

test("a repair that succeeded earlier leaves a later check's repair offered and usable", () => {
  earlier = { outcome: "updated" };
  try {
    const html = render({
      hostname: "own.example.test",
      sources: [{ kind: "route" }],
      zone: "example.test",
      verdict: "elsewhere",
      wildcard: false,
      chain: [],
      addresses: [{ type: "A", content: "100.64.41.99" }],
      reason: "It points at 100.64.41.99, not this Mac (100.64.41.1).",
      fix: {
        op: "update",
        zone: "example.test",
        id: "a1",
        modifiedOn: "m2",
        from: "100.64.41.99",
        record: {
          name: "own.example.test",
          type: "A",
          content: "100.64.41.1",
          ttl: 1,
          proxied: false,
        },
      },
    });
    expect(html).toContain("Changes its A record from 100.64.41.99");
    expect(html).toContain("Point at this Mac");
    expect(html).not.toContain("Pointed at this Mac");
    expect(html).not.toMatch(/<button[^>]* disabled=/);
  } finally {
    earlier = undefined;
  }
});
