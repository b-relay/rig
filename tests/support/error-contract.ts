import { join } from "node:path";
import {
  SignatureKind,
  SymbolFlags,
  type Checker,
  type Program,
  type Type,
} from "typescript/unstable/async";
import {
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isSpreadElement,
  isStringLiteral,
  isSuperExpression,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type NewExpression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { readProductionFiles } from "./production-files";

/** A place where production code breaks the error contract: every error is a RigError or a ConfigError, and a ConfigError
 * has a hint of its own. */
export interface ContractBreach {
  readonly file: string;
  readonly line: number;
  /** `untagged-error`: a construction or call whose result is an error but neither a RigError nor a ConfigError.
   * `untagged-error-class`: a class that extends an error without being either. `config-error-hint`: a ConfigError built
   * without a hint, or with one that may be undefined, so it falls back to the generic default. */
  readonly rule:
    "untagged-error" | "untagged-error-class" | "config-error-hint";
  /** The error's class or interface, such as `Error`, `TypeError` or a class's own name. */
  readonly error: string;
  /** The literal message, else the class's name for a declaration, else the expression's text. */
  readonly text: string;
}

/** The contract's own classes, by the paths every Rig checkout declares them at. */
const TAGGED_CLASSES = [
  { file: "src/domain/errors.ts", name: "RigError" },
  { file: "src/config/errors.ts", name: "ConfigError" },
] as const;

/** The files under `src/` and `web/` of `root` that were read (see `readProductionFiles`), and every breach in them. A
 * file `excluded` names is not read. */
export async function contractBreaches(
  root: string,
  excluded: (file: string) => boolean,
): Promise<{ files: string[]; breaches: ContractBreach[] }> {
  const breaches: ContractBreach[] = [];
  // Resolved per project on its first file to read: a project with none may have no global types at all.
  const contracts = new Map<Checker, Promise<Contract>>();
  const files = await readProductionFiles(
    root,
    excluded,
    async (source, file, { program, checker }) => {
      let contract = contracts.get(checker);
      if (!contract)
        contracts.set(
          checker,
          (contract = contractTypes(root, program, checker)),
        );
      breaches.push(
        ...(await breachesIn(source, file, checker, await contract)),
      );
    },
  );
  return {
    files,
    breaches: breaches.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    ),
  };
}

interface Contract {
  readonly checker: Checker;
  /** The global `Error` interface. */
  readonly error: Type;
  readonly undefined: Type;
  /** The instance types of RigError and ConfigError, where this project holds them. */
  readonly tagged: readonly Type[];
  /** ConfigError's instance type, and its own constructor, which every alias, re-export or subclass that inherits it
   * constructs through. */
  readonly configError?: {
    readonly type: Type;
    readonly path: string;
    readonly index: number;
  };
  /** Whether a type descends from another, by `${ancestor.id}:${type.id}`. */
  readonly descends: Map<string, boolean>;
  readonly untagged: Map<number, Promise<string | undefined>>;
}

async function contractTypes(
  root: string,
  program: Program,
  checker: Checker,
): Promise<Contract> {
  const error = await checker.resolveName("Error", SymbolFlags.Interface);
  if (!error) throw new Error("TypeScript resolved no global Error type.");
  const tagged: Type[] = [];
  let configError: Contract["configError"];
  for (const { file, name } of TAGGED_CLASSES) {
    const source = await program.getSourceFile(join(root, file));
    const declaration = source?.statements.find(
      (statement): statement is ClassDeclaration =>
        isClassDeclaration(statement) && statement.name?.text === name,
    );
    const symbol =
      declaration?.name &&
      (await checker.getSymbolAtLocation(declaration.name));
    if (!symbol) continue;
    const type = await checker.getDeclaredTypeOfSymbol(symbol);
    tagged.push(type);
    const constructor =
      name === "ConfigError" &&
      (
        await checker.getSignaturesOfType(
          (await checker.getTypeOfSymbol(symbol))!,
          SignatureKind.Construct,
        )
      )[0]?.declaration;
    if (constructor)
      configError = {
        type,
        path: constructor.path,
        index: constructor.index,
      };
  }
  return {
    checker,
    error: await checker.getDeclaredTypeOfSymbol(error),
    undefined: await checker.getUndefinedType(),
    tagged,
    ...(configError ? { configError } : {}),
    descends: new Map(),
    untagged: new Map(),
  };
}

async function breachesIn(
  source: SourceFile,
  file: string,
  checker: Checker,
  contract: Contract,
): Promise<ContractBreach[]> {
  const calls: (NewExpression | CallExpression)[] = [];
  const classes: (ClassDeclaration | ClassExpression)[] = [];
  const visit = (node: Node): void => {
    if (isNewExpression(node) || isCallExpression(node)) calls.push(node);
    if (
      (isClassDeclaration(node) || isClassExpression(node)) &&
      node.heritageClauses?.some(
        (clause) => clause.token === SyntaxKind.ExtendsKeyword,
      )
    )
      classes.push(node);
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  const breaches: ContractBreach[] = [];
  const add = (
    node: Node,
    rule: ContractBreach["rule"],
    error: string,
    text: string,
  ) =>
    breaches.push({
      file,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      rule,
      error,
      text,
    });
  if (calls.length) {
    const results = await checker.getTypeAtLocation(calls);
    for (const [index, call] of calls.entries()) {
      const result = results[index];
      const error = result && (await untaggedError(contract, result));
      if (error) add(call, "untagged-error", error, textOf(source, call));
      if (
        (await constructsConfigError(contract, call, result)) &&
        !(await hasOwnHint(contract, call))
      )
        add(call, "config-error-hint", "ConfigError", textOf(source, call));
    }
  }
  for (const declaration of classes) {
    const symbol =
      declaration.name && (await checker.getSymbolAtLocation(declaration.name));
    // An unnamed class is found where it is constructed.
    if (!symbol) continue;
    const error = await untaggedError(
      contract,
      await checker.getDeclaredTypeOfSymbol(symbol),
    );
    if (error)
      add(declaration, "untagged-error-class", error, declaration.name!.text);
  }
  return breaches;
}

/** The name of the error a value of `type` may be when that is neither a RigError nor a ConfigError; undefined otherwise.
 * An error is a type that descends from the global Error by its class or interface heritage. Being assignable to Error is
 * not enough, since any object with a `name` and a `message` is. A union is judged by its members. */
function untaggedError(
  contract: Contract,
  type: Type,
): Promise<string | undefined> {
  return once(contract.untagged, type, async () => {
    if (type.isUnionType()) {
      for (const member of await type.getTypes()) {
        const error = await untaggedError(contract, member);
        if (error) return error;
      }
      return undefined;
    }
    // Assignability first: it rules out almost every type in one question.
    if (
      !(await contract.checker.isTypeAssignableTo(type, contract.error)) ||
      !(await descendsFrom(contract, type, contract.error))
    )
      return undefined;
    // Tagged by heritage too, as `asRigError`'s `instanceof` is: a lookalike `_tag` is not enough.
    for (const tagged of contract.tagged)
      if (await descendsFrom(contract, type, tagged)) return undefined;
    return (await type.getSymbol())?.name ?? "Error";
  });
}

/** Whether `type` descends from `ancestor` by its class or interface heritage, or is it. `seen` holds the types this walk
 * has entered, so a type that refers back to itself ends it. */
async function descendsFrom(
  contract: Contract,
  type: Type,
  ancestor: Type,
  seen = new Set<number>(),
): Promise<boolean> {
  if (type.id === ancestor.id) return true;
  if (seen.has(type.id)) return false;
  seen.add(type.id);
  const key = `${ancestor.id}:${type.id}`;
  const known = contract.descends.get(key);
  if (known !== undefined) return known;
  const related = type.isIntersectionType()
    ? await type.getTypes()
    : type.isTypeReference() && !type.isClassOrInterface()
      ? [await type.getTarget()]
      : ((await type.getBaseTypes()) ?? []);
  let descends = false;
  for (const next of related)
    if (await descendsFrom(contract, next, ancestor, seen)) descends = true;
  contract.descends.set(key, descends);
  return descends;
}

/** Whether `call` runs ConfigError's own constructor: `new` of ConfigError under any name or of a subclass that inherits
 * its constructor, or `super(...)` in a subclass that declares one. */
async function constructsConfigError(
  contract: Contract,
  call: NewExpression | CallExpression,
  result: Type | undefined,
): Promise<boolean> {
  const own = contract.configError;
  if (!own) return false;
  // Only a ConfigError is worth resolving a signature for.
  if (
    isNewExpression(call)
      ? !result || !(await descendsFrom(contract, result, own.type))
      : !isSuperExpression(call.expression)
  )
    return false;
  const declaration = (await contract.checker.getResolvedSignature(call))
    ?.declaration;
  return declaration?.path === own.path && declaration.index === own.index;
}

function once<T>(
  judged: Map<number, Promise<T>>,
  type: Type,
  judge: () => Promise<T>,
): Promise<T> {
  let verdict = judged.get(type.id);
  if (!verdict) judged.set(type.id, (verdict = judge()));
  return verdict;
}

/** ConfigError's hint is its fourth argument: present, not spread, and of a type that cannot be undefined. */
async function hasOwnHint(
  contract: Contract,
  call: NewExpression | CallExpression,
): Promise<boolean> {
  const args = call.arguments ?? [];
  const hint = args[3];
  if (!hint || args.some(isSpreadElement)) return false;
  const type = await contract.checker.getTypeAtLocation(hint);
  return (
    type !== undefined &&
    !(await contract.checker.isTypeAssignableTo(contract.undefined, type))
  );
}

function textOf(
  source: SourceFile,
  call: NewExpression | CallExpression,
): string {
  const first = call.arguments?.[0];
  if (
    first &&
    (isStringLiteral(first) || isNoSubstitutionTemplateLiteral(first))
  )
    return first.text;
  return source.text
    .slice(call.getStart(source), call.end)
    .replace(/\s+/g, " ");
}
