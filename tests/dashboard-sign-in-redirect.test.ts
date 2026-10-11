import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { decide } from "../web/proxy";
import { returnPath } from "../web/lib/return-path";

const admitted = { admitted: true as const, by: "session" as const };
const visit = (path: string) =>
  decide(
    new NextRequest(`https://rig.example.test${path}`),
    admitted,
    new Headers(),
  );

test("a signed-in browser that lands on the sign-in page goes on to where it was going", () => {
  const onward = visit("/sign-in?next=%2Fprojects%2Fpantry%3Ftab%3Dlogs");
  expect(onward.status).toBe(303);
  expect(onward.headers.get("location")).toBe(
    "https://rig.example.test/projects/pantry?tab=logs",
  );
  expect(visit("/sign-in").headers.get("location")).toBe(
    "https://rig.example.test/",
  );
  // Only a path on this site is followed.
  expect(
    visit("/sign-in?next=%2F%2Fevil.example").headers.get("location"),
  ).toBe("https://rig.example.test/");
});

test("a signed-in browser reaches every other page as before", () => {
  expect(visit("/projects/pantry").status).toBe(200);
  expect(visit("/projects/pantry").headers.get("location")).toBeNull();
});

test("a browser without a session is still sent to sign in", () => {
  const refused = decide(
    new NextRequest("https://rig.example.test/projects/pantry"),
    { admitted: false, status: 401, code: "KEY_REQUIRED", message: "Sign in" },
    new Headers(),
  );
  expect(refused.status).toBe(303);
  expect(refused.headers.get("location")).toBe(
    "https://rig.example.test/sign-in?next=%2Fprojects%2Fpantry",
  );
});

test("no crafted next leaves the site: tabs, newlines, backslashes and protocol-relative paths land on the board", () => {
  for (const next of [
    "%2F%09%2Fevil.example",
    "%2F%0A%2Fevil.example",
    "%2F%5Cevil.example",
    "%5C%5Cevil.example",
    "%2F%2Fevil.example",
    "https%3A%2F%2Fevil.example",
    "%2F%2F%09evil.example",
    "%2F.%2F%2Fevil.example",
    "%2F%252e%2F%2Fevil.example",
  ])
    expect(visit(`/sign-in?next=${next}`).headers.get("location")).toBe(
      "https://rig.example.test/",
    );
});

test("returnPath, shared by the sign-in form, never yields a path a browser reads as another host", () => {
  for (const next of [
    "/.//evil.example",
    "/%2e//evil.example",
    "/./\t/evil.example",
    "//evil.example",
    "/\\evil.example",
    "/x/..//evil.example",
    "//[::1]/x",
    "//user@evil.example/",
  ]) {
    const path = returnPath(next);
    expect(path.startsWith("//")).toBe(false);
    expect(new URL(path, "https://rig.example.test").origin).toBe(
      "https://rig.example.test",
    );
  }
  expect(returnPath("/projects/pantry?tab=logs#top")).toBe(
    "/projects/pantry?tab=logs#top",
  );
  expect(returnPath("/a/./b/../c")).toBe("/a/c");
});
