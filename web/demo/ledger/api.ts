// Demo Service for the Rig website's Preview sandbox: a loopback API with a health route.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch: (request) =>
    new URL(request.url).pathname === "/healthz"
      ? new Response("ok")
      : Response.json({ entries: 3, balance: "42.00" }),
});
process.stdout.write(`api listening on ${server.hostname}:${server.port}\n`);

export {};
