import {
  TypeFlags,
  type Checker,
  type Symbol as TsSymbol,
} from "typescript/unstable/async";
import {
  isArrowFunction,
  isAsExpression,
  isAwaitExpression,
  isCallExpression,
  isFunctionExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isTypeAssertion,
  SyntaxKind,
  type CallExpression,
  type Expression,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
} from "typescript/unstable/ast";
import { readProductionFiles } from "./production-files";

/** An external JSON read whose value is used before anything checked it. */
export interface UncheckedRead {
  readonly file: string;
  readonly line: number;
  /** `JSON.parse`, or `.json()` of a body, a Blob or a stream. */
  readonly read: "JSON.parse" | ".json()";
  /** The expression the parsed value first reaches, such as `JSON.parse(text) as Foo`, with its white space collapsed. */
  readonly text: string;
}

/** The interfaces whose `json()` parses what it reads, in the DOM's and Bun's declarations: a fetch Request's or Response's
 * body, a Blob such as `Bun.file(path)`, and a stream. */
const BODY_INTERFACES = new Set([
  "Body",
  "Blob",
  "BunConsumerConvenienceMethods",
]);

/** The files under `src/` and `web/` of `root` that were read (see `readProductionFiles`), and every JSON read in them
 * that is unchecked. A read is checked when its value goes straight to a place typed `unknown`: a Zod schema's parse
 * (`zod` or `zod/mini`) or a hand check's parameter, or a variable, field, return or `.then` callback parameter declared
 * `unknown`, or `as unknown`. From there TypeScript refuses any use that has not narrowed it. Anything else is unchecked:
 * a cast to another type, a property access, a typed or untyped (`any`) variable, a typed parameter. */
export async function uncheckedJsonReads(
  root: string,
  excluded: (file: string) => boolean,
): Promise<{ files: string[]; reads: UncheckedRead[] }> {
  const reads: UncheckedRead[] = [];
  const files = await readProductionFiles(
    root,
    excluded,
    async (source, file, { checker }) => {
      reads.push(...(await uncheckedIn(source, file, checker)));
    },
  );
  return {
    files,
    reads: reads.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    ),
  };
}

type MemberCall = CallExpression & { expression: PropertyAccessExpression };

async function uncheckedIn(
  source: SourceFile,
  file: string,
  checker: Checker,
): Promise<UncheckedRead[]> {
  // Calls of a member named parse or json; the checker says which are JSON reads.
  const candidates: MemberCall[] = [];
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      ["parse", "json"].includes(node.expression.name.text)
    )
      candidates.push(node as MemberCall);
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  if (!candidates.length) return [];
  const symbols = await checker.getSymbolAtLocation(
    candidates.map((call) => call.expression.name),
  );
  const unchecked: UncheckedRead[] = [];
  for (const [index, call] of candidates.entries()) {
    const read = await readKind(symbols[index]);
    if (!read) continue;
    const reached = await reachedBy(checker, call, read === ".json()");
    if (reached)
      unchecked.push({
        file,
        line:
          source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
        read,
        text: source.text
          .slice(reached.getStart(source), reached.end)
          .replace(/\s+/g, " "),
      });
  }
  return unchecked;
}

/** Which JSON read a member is: the global JSON's parse, or the json of a body, a Blob or a stream. */
async function readKind(
  symbol: TsSymbol | undefined,
): Promise<UncheckedRead["read"] | undefined> {
  if (!symbol) return undefined;
  const owner = (await symbol.getParent())?.name;
  if (symbol.name === "parse" && owner === "JSON") return "JSON.parse";
  if (symbol.name === "json" && owner && BODY_INTERFACES.has(owner))
    return ".json()";
  return undefined;
}

const isUnknown = (type: { flags: TypeFlags } | undefined) =>
  type !== undefined && (type.flags & TypeFlags.Unknown) !== 0;

/** The expression an unchecked read's value first reaches, or undefined when the value goes straight to a place typed
 * `unknown`. `promise` says the read gives a promise of the value, as `.json()` does, until it is awaited. */
async function reachedBy(
  checker: Checker,
  read: CallExpression,
  promise: boolean,
): Promise<Expression | undefined> {
  let value: Expression = read;
  for (;;) {
    const parent = value.parent;
    if (
      isParenthesizedExpression(parent) ||
      isNonNullExpression(parent) ||
      isSatisfiesExpression(parent)
    ) {
      value = parent;
      continue;
    }
    if (promise && isAwaitExpression(parent)) {
      value = parent;
      promise = false;
      continue;
    }
    if (
      promise &&
      isPropertyAccessExpression(parent) &&
      parent.expression === value &&
      isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      const call = parent.parent;
      // A fallback for a body that is not JSON keeps the promise of the value.
      if (["catch", "finally"].includes(parent.name.text)) {
        value = call;
        continue;
      }
      // The value is the first callback's parameter.
      const callback = call.arguments[0];
      if (
        parent.name.text === "then" &&
        callback &&
        (isArrowFunction(callback) || isFunctionExpression(callback))
      ) {
        const parameter = callback.parameters[0];
        if (!parameter) return undefined;
        return isUnknown(await checker.getTypeAtLocation(parameter.name))
          ? undefined
          : call;
      }
    }
    break;
  }
  const parent = value.parent;
  if (isAsExpression(parent) || isTypeAssertion(parent))
    return parent.type.kind === SyntaxKind.UnknownKeyword ? undefined : parent;
  if (!promise && isUnknown(await checker.getContextualType(value)))
    return undefined;
  return value;
}
