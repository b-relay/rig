import { describe, expect, test } from "bun:test";
import {
  faviconCache,
  faviconSource,
  iconSourceCache,
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
  test("lets go of expired answers, found or not, without their sources being asked for again", async () => {
    const { icons, advance } = setup({
      [source(1).url]: new Response(PNG),
      [source(3).url]: new Response(PNG),
    });
    await icons.get(source(1));
    await icons.get(source(2));
    expect(icons.retained()).toEqual({ entries: 2, bytes: PNG.byteLength });
    // A source replaced by a new port: the old one is never asked for again.
    advance(2000);
    await icons.get(source(3));
    expect(icons.retained()).toEqual({ entries: 1, bytes: PNG.byteLength });
  });
  test("an expired answer goes when a fresh one is served, too", async () => {
    const { icons, calls, advance } = setup({
      [source(1).url]: new Response(PNG),
      [source(2).url]: new Response(PNG),
    });
    await icons.get(source(1));
    advance(600);
    await icons.get(source(2));
    advance(600);
    await icons.get(source(2));
    expect(calls).toHaveLength(2);
    expect(icons.retained()).toEqual({ entries: 1, bytes: PNG.byteLength });
  });
  test("holds the bytes of the most recent icons within its budget, however many sources it has read", async () => {
    let now = 0;
    const calls: string[] = [];
    const large = new Uint8Array(100_000);
    large.set(PNG);
    const icons = faviconCache({
      now: () => now,
      fetch: async (url) => {
        calls.push(url);
        return new Response(large);
      },
    });
    for (let port = 1; port <= 150; port++) {
      expect((await icons.get(source(port)))?.body.byteLength).toBe(100_000);
      now += 1;
    }
    expect(icons.retained().bytes).toBe(10_000_000);
    expect(icons.retained().entries).toBe(100);
    // The newest is reused; the oldest is read again.
    await icons.get(source(150));
    expect(calls).toHaveLength(150);
    await icons.get(source(1));
    expect(calls).toHaveLength(151);
    expect(icons.retained().bytes).toBe(10_000_000);
  });
  test("holds a bounded number of answers when no source has an icon, and still reuses the recent ones", async () => {
    const { icons, calls } = setup({});
    for (let port = 1; port <= 1000; port++) await icons.get(source(port));
    expect(icons.retained()).toEqual({ entries: 256, bytes: 0 });
    await icons.get(source(1000));
    expect(calls).toHaveLength(1000);
    await icons.get(source(1));
    expect(calls).toHaveLength(1001);
  });
});

describe("project icon sources", () => {
  const found: IconSource = {
    url: "http://127.0.0.1:4000/favicon.ico",
    host: "pantry.test",
  };
  const setup = () => {
    let now = 0;
    const rigd = new Map<string, IconSource>();
    const asked: string[] = [];
    const sources = iconSourceCache({
      now: () => now,
      read: async (project) => {
        asked.push(project);
        return rigd.get(project);
      },
    });
    return { sources, rigd, asked, advance: (ms: number) => (now += ms) };
  };
  test("keeps an answer, found or not, for a minute, so a page of icons is not one status read each", async () => {
    const { sources, rigd, asked, advance } = setup();
    rigd.set("pantry", found);
    expect(await sources.get("pantry")).toEqual(found);
    expect(await sources.get("quill")).toBeUndefined();
    advance(59_000);
    expect(await sources.get("pantry")).toEqual(found);
    expect(await sources.get("quill")).toBeUndefined();
    expect(asked).toEqual(["pantry", "quill"]);
    advance(2_000);
    expect(await sources.get("pantry")).toEqual(found);
    expect(asked).toEqual(["pantry", "quill", "pantry"]);
  });
  test("hundreds of unknown names leave a bounded cache, gone once expired, while a current Project still gets its source", async () => {
    const { sources, rigd, advance } = setup();
    rigd.set("pantry", found);
    for (let i = 0; i < 500; i++) await sources.get(`unknown-${i}`);
    expect(sources.retained().entries).toBe(256);
    advance(61_000);
    expect(await sources.get("pantry")).toEqual(found);
    expect(sources.retained().entries).toBe(1);
  });
  test("a Project forgotten and made again gets its new source once the old answers expire", async () => {
    const { sources, rigd, advance } = setup();
    rigd.set("pantry", found);
    await sources.get("pantry");
    rigd.delete("pantry");
    advance(61_000);
    expect(await sources.get("pantry")).toBeUndefined();
    const moved = { ...found, url: "http://127.0.0.1:4100/favicon.ico" };
    rigd.set("pantry", moved);
    advance(61_000);
    expect(await sources.get("pantry")).toEqual(moved);
    expect(sources.retained().entries).toBe(1);
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
    // The proxy runs on every path; only its public paths go without a session.
    const proxy = await import("../web/proxy");
    expect("config" in proxy).toBe(false);
    expect(proxy.publicPath("/project-icon")).toBe(false);
    expect(proxy.publicPath("/healthz")).toBe(true);
  });
});
