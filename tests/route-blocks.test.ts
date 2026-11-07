import { expect, test } from "bun:test";
import {
  markedRouteBlocks,
  ownedRouteBlocks,
  replaceMarkedRouteBlocks,
  routeOwnerToken,
} from "../src/domain/proxy-publication";
import { bareHostname } from "../src/domain/managed-proxy";
import {
  assertSingleOwners,
  canonicalRouteFile,
  editRouteFile,
  ownedBlock,
  renderOwnedBlock,
  rerenderOwnedBlocks,
  routeFileHostnames,
  siteAddress,
  withoutUnownedBlocks,
  type RouteRequest,
} from "../src/providers/route-file";

const route = (key: string, hostname: string, port: number): RouteRequest => ({
  key,
  sites: [
    { hostname, routes: [{ prefix: "/", upstream: `127.0.0.1:${port}` }] },
  ],
});
const [a, b, c, d] = [
  route("target:a", "a.test", 3000),
  route("target:b", "b.test", 3001),
  route("target:c", "c.test", 3002),
  route("target:d", "d.test", 3003),
];
const token = (request: RouteRequest) => routeOwnerToken(request.key);
const outside = "example.com {\n  respond 200\n}\n";
const blockA = renderOwnedBlock(a, []);
// Written with CRLF line breaks, as an editor on another system might.
const blockB = renderOwnedBlock(b, []).replaceAll("\n", "\r\n");
// A begin marker with no end marker of its token, and a block whose end marker names another token: neither is a block.
const incomplete = `# rig begin ${token(c)}\nc.test {\n  reverse_proxy 127.0.0.1:3002\n}\n`;
const mismatched = `# rig begin ${token(c)}\ne.test {\n  reverse_proxy 127.0.0.1:3004\n}\n# rig end ${token(a)}\n`;
// The last block ends the file with no line break after its end marker.
const blockD = renderOwnedBlock(d, []).replace(/\n$/, "");
const file =
  outside + blockA + blockB + incomplete + mismatched + "# kept\n" + blockD;

test("the complete marked blocks of a route file are found in order, each with its body and its whole text", () => {
  expect(markedRouteBlocks(file)).toEqual([
    {
      token: token(a),
      body: "a.test {\n  reverse_proxy 127.0.0.1:3000\n}\n",
      text: blockA,
    },
    {
      token: token(b),
      body: "b.test {\r\n  reverse_proxy 127.0.0.1:3001\r\n}\r\n",
      text: blockB,
    },
    {
      token: token(d),
      body: "d.test {\n  reverse_proxy 127.0.0.1:3003\n}\n",
      text: blockD,
    },
  ]);
  // Blocks written one right after the other are each found.
  expect(
    markedRouteBlocks(blockA + renderOwnedBlock(b, [])).map(
      (block) => block.token,
    ),
  ).toEqual([token(a), token(b)]);
  expect(markedRouteBlocks(outside + incomplete + mismatched)).toEqual([]);
  expect(ownedRouteBlocks(file)).toEqual([
    { token: token(a), hostnames: ["a.test"] },
    { token: token(b), hostnames: ["b.test"] },
    { token: token(d), hostnames: ["d.test"] },
  ]);
});

test("replacing marked blocks replaces each with the line break after it and leaves all else as it was", () => {
  expect(replaceMarkedRouteBlocks(file, (block) => block.text)).toBe(file);
  expect(replaceMarkedRouteBlocks(file, () => "")).toBe(
    outside + incomplete + mismatched + "# kept\n",
  );
  expect(
    replaceMarkedRouteBlocks(file, (block) =>
      block.token === token(b) ? "[b]\n" : block.text,
    ),
  ).toBe(
    outside + blockA + "[b]\n" + incomplete + mismatched + "# kept\n" + blockD,
  );
});

test("each route-file reader keeps its own policy over the same complete blocks", () => {
  // Rerendering rewrites only the complete blocks, each as Rig renders it, and keeps the rest of the file as text.
  expect(rerenderOwnedBlocks(file, ["tls internal"])).toBe(
    outside +
      renderOwnedBlock(a, ["tls internal"]) +
      renderOwnedBlock(b, ["tls internal"]) +
      incomplete +
      mismatched +
      "# kept\n" +
      renderOwnedBlock(d, ["tls internal"]),
  );
  // The canonical file keeps nothing but the complete blocks' sites.
  expect(canonicalRouteFile(file)).toEqual({
    text: blockA + renderOwnedBlock(b, []) + renderOwnedBlock(d, []),
    dropped: true,
  });
  expect(routeFileHostnames(file)).toEqual(["a.test", "b.test", "d.test"]);
  // A hostname inside an incomplete block belongs to no Target, so it is free for another owner.
  expect(() =>
    assertSingleOwners(file, bareHostname, {
      sites: ["c.test", "e.test"],
      owner: "proxy.routes",
    }),
  ).not.toThrow();
  expect(() =>
    assertSingleOwners(file, siteAddress, {
      sites: ["b.test"],
      owner: "proxy.routes",
    }),
  ).toThrow(
    expect.objectContaining({
      code: "ROUTE_CONFLICT",
      details: expect.objectContaining({ routeTokens: [token(b)] }),
    }),
  );
  // An orphaned block goes with its line break, whichever it was; an incomplete one stays.
  expect(withoutUnownedBlocks(file, new Set([a.key]))).toEqual({
    text: outside + blockA + incomplete + mismatched + "# kept\n",
    hostnames: ["b.test", "d.test"],
  });
  // Looking up one owner's block refuses incomplete markers instead of skipping them.
  expect(ownedBlock(file, b.key)).toBe(blockB);
  expect(() => ownedBlock(file, c.key)).toThrow(
    expect.objectContaining({ code: "ROUTE_CORRUPT" }),
  );
});

test("editing one owner's block keeps every other line of the file", () => {
  const moved = route("target:a", "a.test", 4000);
  const edit = editRouteFile({
    before: file,
    key: a.key,
    route: moved,
    siteConfig: [],
  });
  expect(edit?.after).toBe(
    outside +
      blockB +
      incomplete +
      mismatched +
      "# kept\n" +
      blockD +
      "\n" +
      renderOwnedBlock(moved, []),
  );
});
