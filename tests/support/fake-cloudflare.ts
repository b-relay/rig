/** A fake of Cloudflare's API v4 DNS endpoints on 127.0.0.1, so no test ever reaches the real API. It pages like Cloudflare
 * (page, per_page, result_info), checks the Bearer token, and, to prove Rig redacts it, quotes the Authorization header it
 * was sent in every authentication refusal. */
export interface FakeRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  comment?: string | null;
  modified_on: string;
  data?: unknown;
}
export interface SeenRequest {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
  body?: unknown;
}
export interface FakeCloudflareOptions {
  token: string;
  zones: { id: string; name: string; status?: string }[];
  records?: Record<string, Omit<FakeRecord, "modified_on">[]>;
  /** The most items one page holds, whatever per_page asks: Cloudflare's own cap is far larger. */
  pageCap?: number;
  /** Leave result_info out of listings, as a proxy in between might. */
  omitResultInfo?: boolean;
}
export function fakeCloudflare(options: FakeCloudflareOptions) {
  const requests: SeenRequest[] = [];
  let tick = 0;
  const stamp = () =>
    new Date(Date.UTC(2026, 9, 1, 0, 0, tick++)).toISOString();
  const records = new Map<string, FakeRecord[]>(
    options.zones.map((zone) => [
      zone.id,
      (options.records?.[zone.id] ?? []).map((record) => ({
        ...record,
        modified_on: stamp(),
      })),
    ]),
  );
  /** The next answer, replacing whatever the route would say; then normal service resumes. */
  const scripted: {
    status: number;
    body: unknown;
    delayMs?: number;
    method?: string;
  }[] = [];
  let ids = 0;
  const newId = () => (++ids).toString(16).padStart(32, "a");
  const failure = (status: number, code: number, message: string) =>
    Response.json(
      {
        success: false,
        errors: [{ code, message }],
        messages: [],
        result: null,
      },
      { status },
    );
  const page = <T>(items: T[], url: URL) => {
    const perPage = Math.min(
      Number(url.searchParams.get("per_page") ?? 20),
      options.pageCap ?? 5000,
    );
    const number = Number(url.searchParams.get("page") ?? 1);
    const slice = items.slice((number - 1) * perPage, number * perPage);
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: slice,
      ...(options.omitResultInfo
        ? {}
        : {
            result_info: {
              page: number,
              per_page: perPage,
              count: slice.length,
              total_count: items.length,
              total_pages: Math.max(1, Math.ceil(items.length / perPage)),
            },
          }),
    });
  };
  const ok = (result: unknown) =>
    Response.json({ success: true, errors: [], messages: [], result });
  /** Answers to send late: the request is carried out (a write commits), then the answer waits. */
  const slow: { method: string; delayMs: number }[] = [];
  /** Methods whose next answer is cut off partway through its body, after the request was carried out. */
  const cutOff: string[] = [];
  /** Zones every request about fails with Cloudflare's refusal, as for a token without access to them. */
  const broken = new Map<
    string,
    { status: number; code: number; message: string }
  >();
  const routes = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const body =
        request.method === "POST" || request.method === "PATCH"
          ? await request.json().catch(() => undefined)
          : undefined;
      requests.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers.get("authorization"),
        ...(body !== undefined ? { body } : {}),
      });
      const at = scripted.findIndex(
        (each) => !each.method || each.method === request.method,
      );
      const next = at < 0 ? undefined : scripted.splice(at, 1)[0];
      if (next) {
        if (next.delayMs) await Bun.sleep(next.delayMs);
        return typeof next.body === "string"
          ? new Response(next.body, { status: next.status })
          : Response.json(next.body, { status: next.status });
      }
      const zoneId = /\/zones\/([^/]+)\//.exec(url.pathname)?.[1];
      const refusal = zoneId ? broken.get(zoneId) : undefined;
      if (refusal)
        return failure(refusal.status, refusal.code, refusal.message);
      const authorization = request.headers.get("authorization");
      if (authorization !== `Bearer ${options.token}`)
        return failure(403, 9109, `Invalid access token: ${authorization}`);
      const path = url.pathname.replace(/^\/client\/v4/, "");
      if (path === "/zones" && request.method === "GET")
        return page(
          options.zones.map((zone) => ({ status: "active", ...zone })),
          url,
        );
      const match = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
      const zone = match ? records.get(match[1]!) : undefined;
      if (!match || !zone) return failure(404, 7003, "Could not route.");
      const zoneName = options.zones.find((each) => each.id === match[1])!.name;
      const id = match[2];
      const found = id ? zone.find((record) => record.id === id) : undefined;
      if (id && !found) return failure(404, 81044, "Record does not exist.");
      const input = (body ?? {}) as Partial<FakeRecord> & {
        data?: { flags: number; tag: string; value: string };
      };
      const content = (value: typeof input) =>
        value.data
          ? `${value.data.flags} ${value.data.tag} "${value.data.value}"`
          : value.content;
      switch (request.method) {
        case "GET":
          return found ? ok(found) : page(zone, url);
        case "POST": {
          const name = String(input.name).endsWith(zoneName)
            ? String(input.name)
            : `${input.name}.${zoneName}`;
          if (
            zone.some(
              (record) =>
                record.name === name &&
                record.type === input.type &&
                record.content === content(input),
            )
          )
            return failure(400, 81058, "An identical record already exists.");
          const created: FakeRecord = {
            id: newId(),
            name,
            type: String(input.type),
            // Cloudflare stores an IPv6 address in its canonical text (RFC 5952), as the WHATWG URL parser writes it.
            content:
              input.type === "AAAA"
                ? new URL(`http://[${String(input.content)}]/`).hostname.slice(
                    1,
                    -1,
                  )
                : String(content(input)),
            ttl: Number(input.ttl ?? 1),
            ...(input.proxied !== undefined
              ? { proxied: input.proxied }
              : { proxied: false }),
            ...(input.priority !== undefined
              ? { priority: input.priority }
              : {}),
            comment: input.comment ?? null,
            modified_on: stamp(),
          };
          zone.push(created);
          return ok(created);
        }
        case "PATCH": {
          Object.assign(found!, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(content(input) !== undefined
              ? { content: content(input) }
              : {}),
            ...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
            ...(input.proxied !== undefined ? { proxied: input.proxied } : {}),
            ...(input.priority !== undefined
              ? { priority: input.priority }
              : {}),
            ...(input.comment !== undefined ? { comment: input.comment } : {}),
            modified_on: stamp(),
          });
          return ok(found);
        }
        case "DELETE":
          zone.splice(zone.indexOf(found!), 1);
          return ok({ id });
      }
      return failure(405, 10000, "Method not allowed.");
    },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const response = await routes.fetch(request);
      const cut = cutOff.indexOf(request.method);
      if (cut >= 0) {
        cutOff.splice(cut, 1);
        // The request is carried out, then the answer stops partway: the connection drops mid-body.
        const text = await response.text();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(text.slice(0, 12)));
              // Later, so the status line and the first bytes reach the client before the drop.
              setTimeout(
                () => controller.error(new Error("connection dropped")),
                100,
              );
            },
          }),
          {
            status: response.status,
            headers: { "content-type": "application/json" },
          },
        );
      }
      const at = slow.findIndex((each) => each.method === request.method);
      if (at >= 0) await Bun.sleep(slow.splice(at, 1)[0]!.delayMs);
      return response;
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/client/v4`,
    requests,
    records,
    /** Answers the next request (of `method`, when given) with `status` and `body`; a string is sent as is, so it need not
     * be JSON. */
    answerNext(
      status: number,
      body: unknown,
      delayMs?: number,
      method?: string,
    ) {
      scripted.push({
        status,
        body,
        ...(delayMs ? { delayMs } : {}),
        ...(method ? { method } : {}),
      });
    },
    /** Fails every request about one zone's records with `status`, as for a token that cannot read them. */
    breakZone(zoneId: string, status: number, code: number, message: string) {
      broken.set(zoneId, { status, code, message });
    },
    /** Carries out the next request of `method`, then cuts its answer off partway through the body. */
    cutOffNext(method: string) {
      cutOff.push(method);
    },
    /** Carries out the next request of `method` but answers only after `delayMs`, as when the answer to a write that
     * Cloudflare made is lost. */
    answerLate(method: string, delayMs: number) {
      slow.push({ method, delayMs });
    },
    /** Changes a record behind Rig's back, as someone in the Cloudflare dashboard would. */
    touch(zoneId: string, recordId: string, change: Partial<FakeRecord>) {
      const record = records.get(zoneId)!.find((each) => each.id === recordId)!;
      Object.assign(record, change, { modified_on: stamp() });
    },
    stop: () => server.stop(true),
  };
}
