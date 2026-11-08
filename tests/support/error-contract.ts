import { join, relative } from "node:path";
import { API } from "typescript/unstable/async";
import {
  isCallExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  isThrowStatement,
  type Expression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

/** A place where production code breaks the error contract: a tagged error with structured context and its own hint. */
export interface ContractBreach {
  readonly file: string;
  readonly line: number;
  readonly rule: "plain-throw" | "assigned-error" | "config-error-hint";
  /** The first argument when it is a literal message, which names an allowed sentinel without tying it to a line. */
  readonly message?: string;
}

const builtInErrors = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

/** The production files under `src/` and `web/` of `root` that were read, and every breach in them. They are read through
 * the TypeScript projects of its `tsconfig.json` and, when present, `web/tsconfig.json`, with TypeScript 7's parser, which
 * only its unstable API offers; package.json pins that version. Test files are not production code. */
export async function contractBreaches(
  root: string,
): Promise<{ files: string[]; breaches: ContractBreach[] }> {
  const api = new API({ cwd: root });
  try {
    const projects = [join(root, "tsconfig.json")];
    if (await Bun.file(join(root, "web", "tsconfig.json")).exists())
      projects.push(join(root, "web", "tsconfig.json"));
    const snapshot = await api.updateSnapshot({ openProjects: projects });
    const files = new Set<string>();
    const breaches: ContractBreach[] = [];
    for (const project of snapshot.getProjects())
      for (const name of await project.program.getSourceFileNames()) {
        const file = relative(root, name);
        if (files.has(file) || !isProduction(file)) continue;
        files.add(file);
        const source = await project.program.getSourceFile(name);
        if (source) breaches.push(...breachesIn(source, file));
      }
    return {
      files: [...files].sort(),
      breaches: breaches.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
      ),
    };
  } finally {
    await api.close();
  }
}

function isProduction(file: string): boolean {
  return (
    /^(src|web)\//.test(file) &&
    !file.includes("node_modules/") &&
    !/\.test\.tsx?$/.test(file)
  );
}

function breachesIn(source: SourceFile, file: string): ContractBreach[] {
  const breaches: ContractBreach[] = [];
  const add = (node: Node, rule: ContractBreach["rule"], error?: Expression) =>
    breaches.push({
      file,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      rule,
      ...literalMessage(error),
    });
  const visit = (node: Node): void => {
    if (isThrowStatement(node) && builtInError(node.expression))
      add(node.expression, "plain-throw", node.expression);
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "assign" &&
      node.arguments[0] !== undefined &&
      builtInError(node.arguments[0])
    )
      add(node, "assigned-error", node.arguments[0]);
    if (
      isNewExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === "ConfigError" &&
      (node.arguments?.length ?? 0) < 4
    )
      add(node, "config-error-hint", node);
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return breaches;
}

/** `new Error(...)` or `Error(...)` for a built-in error class, which carries no code, context or hint. */
function builtInError(expression: Expression): boolean {
  return (
    (isNewExpression(expression) || isCallExpression(expression)) &&
    isIdentifier(expression.expression) &&
    builtInErrors.has(expression.expression.text)
  );
}

function literalMessage(error: Expression | undefined): { message?: string } {
  const first =
    error && (isNewExpression(error) || isCallExpression(error))
      ? error.arguments?.[0]
      : undefined;
  return first &&
    (isStringLiteral(first) || isNoSubstitutionTemplateLiteral(first))
    ? { message: first.text }
    : {};
}
