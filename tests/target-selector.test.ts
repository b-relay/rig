import { expect, test } from "bun:test";
import {
  deploySelector,
  generatedPreviewName,
  targetSelector,
} from "../src/domain/target-selector";

test("a printed command always names its Target: the role, the Branch of a generated Preview, or an explicit Preview name", () => {
  const generated = {
    kind: "preview" as const,
    name: generatedPreviewName("feature/x"),
    branch: "feature/x",
  };
  const named = { kind: "preview" as const, name: "demo", branch: "feature/x" };
  expect(targetSelector({ kind: "working", name: "working" })).toBe("working");
  expect(targetSelector({ kind: "stable", name: "stable" })).toBe("stable");
  expect(targetSelector(generated)).toBe("preview feature/x");
  expect(targetSelector(named)).toBe("preview --deployment demo");
  expect(deploySelector({ kind: "stable", name: "stable" })).toBe("stable");
  expect(deploySelector(generated)).toBe("preview feature/x");
  // Deploying by name alone would take the current Branch, so the Branch goes with it.
  expect(deploySelector(named)).toBe("preview feature/x --deployment demo");
  expect(deploySelector({ kind: "preview", name: "demo" })).toBe(
    "preview --deployment demo",
  );
});

test("a Branch the shell would read is quoted, so a copied hint selects exactly that Preview", () => {
  const preview = (branch: string) => ({
    kind: "preview" as const,
    name: generatedPreviewName(branch),
    branch,
  });
  expect(targetSelector(preview("feat/(draft)"))).toBe(
    "preview 'feat/(draft)'",
  );
  expect(deploySelector(preview("fix/$HOME"))).toBe("preview 'fix/$HOME'");
  // zsh expands a word starting with = to a command's path.
  expect(targetSelector(preview("=ls"))).toBe("preview '=ls'");
  expect(targetSelector(preview("it's"))).toBe("preview 'it'\\''s'");
  expect(deploySelector({ kind: "preview", name: "demo", branch: "a b" })).toBe(
    "preview 'a b' --deployment demo",
  );
});
