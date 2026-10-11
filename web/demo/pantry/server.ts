// Demo Service for the Rig website's Preview sandbox: answers on loopback and logs each request.
import { deflateSync } from "node:zlib";

const greeting = process.env.GREETING ?? "hello";
const favicon = icon();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/healthz")
      process.stdout.write(`${request.method} ${path}\n`);
    if (path === "/favicon.ico")
      return new Response(favicon, {
        headers: { "content-type": "image/png" },
      });
    return new Response(path === "/healthz" ? "ok" : `${greeting}\n`);
  },
});
process.stdout.write(`listening on ${server.hostname}:${server.port}\n`);
setInterval(
  () => process.stdout.write(`heartbeat ${new Date().toISOString()}\n`),
  15_000,
);

/** A 32×32 PNG drawn in code, so the dashboard's corner shows a favicon: a jar on amber. */
function icon(): Uint8Array {
  const size = 32;
  const rows: number[] = [];
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) {
      const lid = y >= 6 && y < 10 && x >= 10 && x < 22;
      const jar = y >= 10 && y < 27 && x >= 8 && x < 24;
      const [r, g, b] = lid
        ? [120, 72, 24]
        : jar
          ? [255, 248, 235]
          : [232, 148, 40];
      rows.push(r, g, b, 255);
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    const out = new DataView(new ArrayBuffer(12 + data.length));
    out.setUint32(0, data.length);
    new Uint8Array(out.buffer).set(body, 4);
    out.setUint32(8 + data.length, Bun.hash.crc32(body));
    return new Uint8Array(out.buffer);
  };
  const header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, size);
  header.setUint32(4, size);
  header.setUint8(8, 8); // bit depth
  header.setUint8(9, 6); // RGBA
  return new Uint8Array([
    ...Buffer.from("89504e470d0a1a0a", "hex"), // the PNG signature
    ...chunk("IHDR", new Uint8Array(header.buffer)),
    ...chunk("IDAT", deflateSync(new Uint8Array(rows))),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

export {};
