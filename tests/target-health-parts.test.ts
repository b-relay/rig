import { expect, test } from "bun:test";
import { failureReason, healthOutput } from "../src/adapters/target-health";

test("a failed check's evidence is stderr's last whole line, its secrets redacted, cut to 160 characters", () => {
  expect(
    healthOutput(
      { exitCode: 1, stdout: "out\n", stderr: "first\nleaked hunter2\n\n" },
      ["hunter2"],
    ),
  ).toBe("leaked [redacted]");
  expect(
    healthOutput({ exitCode: 1, stdout: "only stdout\n", stderr: "  \n" }, []),
  ).toBe("only stdout");
  expect(
    healthOutput({ exitCode: 1, stdout: "x".repeat(200), stderr: "" }, []),
  ).toBe("x".repeat(160));
  expect(healthOutput({ exitCode: 1, stdout: "", stderr: "" }, [])).toBe(
    undefined,
  );
});

test("a stream the runner cut loses its partial first line, and with no whole line left gives nothing", () => {
  expect(
    healthOutput(
      {
        exitCode: 1,
        stdout: "",
        stderr: "ter2 tail\nwhole line\n",
        truncated: { stderr: true },
      },
      ["hunter2"],
    ),
  ).toBe("whole line");
  expect(
    healthOutput(
      {
        exitCode: 1,
        stdout: "",
        stderr: "partial only",
        truncated: { stderr: true },
      },
      [],
    ),
  ).toBe(undefined);
});

test("a probe failure is named by its code, else its message", () => {
  expect(
    failureReason(
      Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
    ),
  ).toBe("ECONNREFUSED");
  expect(failureReason(Object.assign(new Error("no code"), { code: "" }))).toBe(
    "no code",
  );
  expect(failureReason(new Error("plain"))).toBe("plain");
  expect(failureReason("text")).toBe("text");
});
