// Demo Service for the Rig website's Preview sandbox: answers on loopback and logs each request.
const greeting = process.env.GREETING ?? "hello";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/healthz")
      process.stdout.write(`${request.method} ${path}\n`);
    return new Response(path === "/healthz" ? "ok" : `${greeting}\n`);
  },
});
process.stdout.write(`listening on ${server.hostname}:${server.port}\n`);
setInterval(
  () => process.stdout.write(`heartbeat ${new Date().toISOString()}\n`),
  15_000,
);

export {};
