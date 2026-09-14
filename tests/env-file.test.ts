import { expect, test } from "bun:test";
import { parseEnvironmentFile } from "../src/adapters/env-file";

function rejection(text: string): unknown {
  try {
    parseEnvironmentFile(text, "/work/.env");
  } catch (error) {
    return error;
  }
  throw new Error("accepted");
}

test("a comment may follow a value, quoted or not, and a # inside quotes is part of the value", () => {
  expect(
    parseEnvironmentFile(
      'A="abc" # rotate monthly\nB=\'x y\'  #c\nC=plain # note\nD="a #b"\nexport E=\nF="line\\nbreak"\n\n# only a comment\n',
      "/work/.env",
    ),
  ).toEqual({
    A: "abc",
    B: "x y",
    C: "plain",
    D: "a #b",
    E: "",
    F: "line\nbreak",
  });
});

test("every rejection names the file and the line", () => {
  expect(rejection('OK=1\nKEY="\n')).toMatchObject({
    code: "ENV_FILE",
    message:
      "The environment file /work/.env has an unmatched quote on line 2.",
    details: { path: "/work/.env", line: 2 },
  });
  expect(rejection("OK=1\n\nKEY\n")).toMatchObject({
    code: "ENV_FILE",
    message:
      "The environment file /work/.env has an unsupported assignment on line 3.",
    details: { path: "/work/.env", line: 3 },
  });
  expect(rejection('KEY="a"b\n')).toMatchObject({
    code: "ENV_FILE",
    message:
      "The environment file /work/.env has text after the closing quote on line 1.",
    details: { path: "/work/.env", line: 1 },
  });
});
