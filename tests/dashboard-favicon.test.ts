import { describe, expect, test } from "bun:test";
import {
  faviconCache,
  faviconSource,
  imageType,
  isLoopbackUrl,
  projectIconResponse,
  type IconSource,
} from "../web/server/favicon";
import type { TargetReport } from "../web/lib/types";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = new TextEncoder().encode("GIF89a....");
const WEBP = new TextEncoder().encode("RIFF\x10\x00\x00\x00WEBPVP8 ");
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
);
const stable = (fields: Partial<TargetReport>): TargetReport => ({
  name: "stable",
  kind: "stable",
  state: "running",
  components: [],
  ...fields,
});

describe("favicon source", () => {
  test("is the loopback port the route map sends / to, under the Target's hostname", () => {
    expect(
      faviconSource(
        stable({
          route: "pantry.test",
          routes: [
            { prefix: "/api", service: "api", port: 4100 },
            { prefix: "/", service: "web", port: 4000 },
          ],
        }),
      ),
    ).toEqual({
      url: "http://127.0.0.1:4000/favicon.ico",
      host: "pantry.test",
    });
  });
  test("falls back to the Service status marks as routed, and is nothing without a hostname or a port", () => {
    expect(
      faviconSource(
        stable({
          route: "https://Rig.Example.com",
          components: [
            { name: "db", kind: "persistent", state: "ready", port: 5432 },
            {
              name: "web",
              kind: "managed",
              state: "running",
              port: 4000,
              route: "rig.example.com",
            },
          ],
        }),
      ),
    ).toEqual({
      url: "http://127.0.0.1:4000/favicon.ico",
      host: "rig.example.com",
    });
    expect(faviconSource(stable({}))).toBeUndefined();
    expect(faviconSource(stable({ route: "pantry.test" }))).toBeUndefined();
  });
  test("only plain HTTP to 127.0.0.1 or localhost counts as loopback", () => {
    expect(isLoopbackUrl("http://127.0.0.1:4000/favicon.ico")).toBe(true);
    expect(isLoopbackUrl("http://localhost:4000/favicon.ico")).toBe(true);
    for (const url of [
      "https://127.0.0.1/favicon.ico",
      "http://10.0.0.5/favicon.ico",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.1/favicon.ico",
      "http://example.com/favicon.ico",
      "http://127.0.0.1.example.com/favicon.ico",
      "http://[::1]/favicon.ico",
      "not a url",
    ])
      expect(isLoopbackUrl(url)).toBe(false);
  });
});

describe("image type", () => {
  test("is read from the bytes: PNG, ICO, JPEG, GIF and WebP", () => {
    expect(imageType(PNG)).toBe("image/png");
    expect(imageType(ICO)).toBe("image/x-icon");
    expect(imageType(JPEG)).toBe("image/jpeg");
    expect(imageType(GIF)).toBe("image/gif");
    expect(imageType(WEBP)).toBe("image/webp");
  });
  test("refuses SVG, HTML and anything else", () => {
    expect(imageType(SVG)).toBeUndefined();
    expect(imageType(new TextEncoder().encode("<html>"))).toBeUndefined();
    expect(imageType(new Uint8Array())).toBeUndefined();
  });
});

describe("favicon cache", () => {
  const source = (port: number): IconSource => ({
    url: `http://127.0.0.1:${port}/favicon.ico`,
    host: "pantry.test",
  });
  const setup = (answers: Record<string, Response | Error>) => {
    let now = 0;
    const calls: { url: string; host: string; redirect: string }[] = [];
    const icons = faviconCache({
      now: () => now,
      ttlMs: 1000,
      fetch: async (url, init) => {
        calls.push({ url, host: init.headers.host, redirect: init.redirect });
        const answer = answers[url];
        if (answer instanceof Error) throw answer;
        return answer ?? new Response(null, { status: 404 });
      },
    });
    return { icons, calls, advance: (ms: number) => (now += ms) };
  };
  test("keeps a raster image, typed by its bytes, asked for under the Target's hostname without redirects", async () => {
    const { icons, calls } = setup({
      [source(4000).url]: new Response(PNG, {
        headers: { "content-type": "image/x-icon" },
      }),
    });
    expect(await icons.get(source(4000))).toEqual({
      body: PNG,
      type: "image/png",
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:4000/favicon.ico",
        host: "pantry.test",
        redirect: "manual",
      },
    ]);
  });
  test("refuses an SVG labelled image/png, a redirect, an oversized answer and a failure", async () => {
    const { icons } = setup({
      [source(1).url]: new Response(SVG, {
        headers: { "content-type": "image/png" },
      }),
      [source(2).url]: new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/" },
      }),
      [source(3).url]: new Response(PNG, {
        headers: { "content-length": "500000" },
      }),
      [source(4).url]: new Response(
        new Uint8Array([...PNG, ...new Uint8Array(200_000)]),
      ),
      [source(5).url]: new Error("ECONNREFUSED"),
    });
    for (const port of [1, 2, 3, 4, 5, 6])
      expect(await icons.get(source(port))).toBeUndefined();
  });
  test("never sends a request to a source that is not loopback", async () => {
    const { icons, calls } = setup({});
    for (const url of [
      "http://10.0.0.5/favicon.ico",
      "http://example.com/favicon.ico",
      "https://127.0.0.1/favicon.ico",
    ])
      expect(await icons.get({ url, host: "pantry.test" })).toBeUndefined();
    expect(calls).toEqual([]);
  });
  test("caches every answer for its window", async () => {
    const { icons, calls, advance } = setup({
      [source(5).url]: new Error("ECONNREFUSED"),
    });
    await icons.get(source(5));
    await icons.get(source(5));
    expect(calls).toHaveLength(1);
    advance(2000);
    await icons.get(source(5));
    expect(calls).toHaveLength(2);
  });
});

describe("project icon route", () => {
  test("serves the icon from the source rigd's status names, typed by its bytes, and 404s without one", async () => {
    const asked: IconSource[] = [];
    const deps = {
      iconSource: async (project: string) =>
        project === "pantry"
          ? { url: "http://127.0.0.1:4000/favicon.ico", host: "pantry.test" }
          : undefined,
      icons: {
        get: async (source: IconSource) => {
          asked.push(source);
          return { body: new Uint8Array(PNG), type: "image/png" };
        },
      },
    };
    const found = await projectIconResponse("pantry", deps);
    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toBe("image/png");
    expect(found.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await projectIconResponse("quill", deps)).status).toBe(404);
    expect((await projectIconResponse(null, deps)).status).toBe(404);
    expect(asked).toEqual([
      { url: "http://127.0.0.1:4000/favicon.ico", host: "pantry.test" },
    ]);
  });
  test("sits behind the site's admission", async () => {
    const source = await Bun.file(
      new URL("../web/proxy.ts", import.meta.url),
    ).text();
    const matcher = source.match(/matcher: \["(.+)"\]/)?.[1];
    expect(matcher).toBeDefined();
    const pattern = new RegExp(`^${matcher!}$`);
    expect(pattern.test("/project-icon")).toBe(true);
    expect(pattern.test("/healthz")).toBe(false);
  });
});
