import {
  isMap,
  isPair,
  isScalar,
  parseDocument,
  visit,
  type Document,
  type Pair,
  type Scalar,
  type YAMLMap,
} from "yaml";
import { ConfigError } from "./errors";
import {
  LATEST_FORMAT,
  movedReference,
  stepsFrom,
  type ConfigFormat,
  type FormatStep,
  type MovedSetting,
} from "./formats";
import { rewriteReferences } from "./references";

/** The committed JSON Schema file of each format, which a yaml-language-server comment names. */
const SCHEMA_FILES: Readonly<Record<ConfigFormat, string>> = {
  "rig/v1": "rig-v1.schema.json",
  "rig/v2": "rig.schema.json",
};

/** Pure: the text of a validated rig.yaml written in `format`, rewritten into the latest format, and what changed in words,
 * one line each. Only what the format change needs is touched, as text: `format` is set, a yaml-language-server comment
 * that names the older format's schema names the current one, every `${...}` reference to a moved setting follows it, and
 * each moved Service setting (in every Service and every role's Service patch) moves into its block with the comment lines
 * above it and its trailing comment. Every other byte stays as it was: comments, order, quoting, blank lines, flow style
 * and line length. Nothing changes for the latest format. Throws ConfigError `upgrade_lossy` rather than drop a comment
 * inside a flow mapping. The caller checks that the result parses to the same config. */
export function upgradeYamlText(
  raw: string,
  format: ConfigFormat,
): { raw: string; changes: string[] } {
  const steps = stepsFrom(format);
  if (!steps.length) return { raw, changes: [] };
  let text = raw;
  const changes: string[] = [];
  const pass = (edit: (document: Document) => TextEdit[]) => {
    text = applyEdits(text, edit(parse(text)), changes);
  };
  pass((document) => [
    ...setFormat(document, text, format),
    ...schemaComment(text, format),
  ]);
  for (const step of steps) {
    pass((document) => followReferences(document, text, step));
    pass((document) =>
      serviceMaps(document).flatMap(([at, service]) =>
        moveSettings(service, at, text, step),
      ),
    );
  }
  return { raw: text, changes };
}

/** One replacement of source text, and the changes it makes in words. */
interface TextEdit {
  start: number;
  end: number;
  text: string;
  changes?: readonly string[];
}
function applyEdits(
  text: string,
  edits: readonly TextEdit[],
  changes: string[],
): string {
  for (const edit of edits) changes.push(...(edit.changes ?? []));
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
function parse(text: string): Document {
  return parseDocument(text, { version: "1.2", uniqueKeys: true });
}
/** Offset of the start of the line holding `offset`. */
function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}
/** Offset just past the newline ending the line holding `offset`, or the end of the text. */
function lineEnd(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end + 1;
}
/** A key written the way `like` was: quoted with the same quote, or plain. */
function keyLike(like: Scalar, name: string): string {
  return like.type === "QUOTE_DOUBLE"
    ? `"${name}"`
    : like.type === "QUOTE_SINGLE"
      ? `'${name}'`
      : name;
}
const MODELINE = /^#\s*yaml-language-server:/;

/** Sets `format` to the latest: in place when the file declares one, otherwise as its first setting, below a leading
 * yaml-language-server comment, which editors read only at the top. */
function setFormat(
  document: Document,
  text: string,
  format: ConfigFormat,
): TextEdit[] {
  const root = document.contents;
  if (!isMap(root)) return [];
  const declared = root.items.find(
    (pair) => isScalar(pair.key) && pair.key.value === "format",
  );
  if (declared && isScalar(declared.value) && declared.value.range)
    return [
      {
        start: declared.value.range[0],
        end: declared.value.range[1],
        text: LATEST_FORMAT,
        changes: [`format: ${LATEST_FORMAT} (was ${format})`],
      },
    ];
  const changes = [
    `format: ${LATEST_FORMAT} (added; a file without it is ${format})`,
  ];
  if (root.flow) {
    const open = root.range![0] + 1;
    const padded = /\s/.test(text[open] ?? "");
    return [
      {
        start: open,
        end: open,
        text: `${padded ? " " : ""}format: ${LATEST_FORMAT},`,
        changes,
      },
    ];
  }
  const first = root.items[0];
  if (!isScalar(first?.key) || !first.key.range) return [];
  // The comment lines just above the first setting belong to it; `format` goes above them, but below the last
  // yaml-language-server line among them.
  const keyLine = lineStart(text, first.key.range[0]);
  let top = keyLine;
  while (top > 0) {
    const previous = lineStart(text, top - 1);
    if (!text.slice(previous, top).startsWith("#")) break;
    top = previous;
  }
  let insert = top;
  for (let line = top; line < keyLine; line = lineEnd(text, line))
    if (MODELINE.test(text.slice(line, lineEnd(text, line))))
      insert = lineEnd(text, line);
  return [
    {
      start: insert,
      end: insert,
      text: `format: ${LATEST_FORMAT}\n`,
      changes,
    },
  ];
}
/** A yaml-language-server comment in the leading comment lines that names the older format's schema file names the current
 * one's, so the editor checks the upgraded file against the schema it is written in. */
function schemaComment(text: string, format: ConfigFormat): TextEdit[] {
  const older = SCHEMA_FILES[format],
    current = SCHEMA_FILES[LATEST_FORMAT];
  const edits: TextEdit[] = [];
  for (let line = 0; line < text.length; line = lineEnd(text, line)) {
    const content = text.slice(line, lineEnd(text, line));
    if (content.trim() && !content.startsWith("#")) break;
    const at = content.indexOf(older);
    if (!MODELINE.test(content) || at === -1) continue;
    edits.push({
      start: line + at,
      end: line + at + older.length,
      text: current,
      changes: [
        `yaml-language-server comment: ${older} -> ${current}, the schema of ${LATEST_FORMAT}`,
      ],
    });
  }
  return edits;
}

/** Every `${...}` reference to a moved setting, in any string value, spelled the way the step spells it. The key is
 * replaced inside the value's own source text, so its quoting stays; a value whose source spells the reference with an
 * escape is written again as a double-quoted string. */
function followReferences(
  document: Document,
  text: string,
  step: FormatStep,
): TextEdit[] {
  const edits: TextEdit[] = [];
  visit(document, {
    Scalar(key, node, path) {
      if (key === "key" || typeof node.value !== "string" || !node.range)
        return;
      const rename = (reference: string) => movedReference(step, reference);
      const next = rewriteReferences(node.value, rename);
      if (next === node.value) return;
      const [start, end] = node.range;
      const spliced = rewriteReferences(text.slice(start, end), rename);
      edits.push({
        start,
        end,
        text: scalarValue(spliced) === next ? spliced : JSON.stringify(next),
        changes: [`${dotted(path, key)}: ${node.value} -> ${next}`],
      });
    },
  });
  return edits;
}
/** The string one scalar's source text means on its own, or undefined when it is not one scalar. */
function scalarValue(source: string): unknown {
  const document = parse(source);
  return !document.errors.length && isScalar(document.contents)
    ? document.contents.value
    : undefined;
}
/** The dotted config path of a node from its ancestors, such as services.api.env.URL. */
function dotted(path: readonly unknown[], key: unknown): string {
  const segments: string[] = [];
  for (const node of path)
    if (isPair(node) && isScalar(node.key))
      segments.push(String(node.key.value));
  if (typeof key === "number") segments.push(String(key));
  return segments.join(".");
}

/** Every Service mapping with its path: `services.<name>` and `targets.<role>.services.<name>`. */
function serviceMaps(document: Document): [string[], YAMLMap][] {
  const found: [string[], YAMLMap][] = [];
  const collect = (services: unknown, at: string[]) => {
    if (!isMap(services)) return;
    for (const pair of services.items)
      if (isScalar(pair.key) && isMap(pair.value))
        found.push([[...at, String(pair.key.value)], pair.value]);
  };
  collect(document.get("services", true), ["services"]);
  const targets = document.get("targets", true);
  if (isMap(targets))
    for (const pair of targets.items)
      if (isScalar(pair.key) && isMap(pair.value))
        collect(pair.value.get("services", true), [
          "targets",
          String(pair.key.value),
          "services",
        ]);
  return found;
}

type Moved = { pair: Pair<Scalar, Scalar>; move: MovedSetting };
/** Moves the step's settings of one Service into their block, which takes the place of the first one moved. */
function moveSettings(
  service: YAMLMap,
  at: readonly string[],
  text: string,
  step: FormatStep,
): TextEdit[] {
  const moved = service.items.flatMap((pair): Moved[] => {
    const move = step.moves.find(
      (each) => isScalar(pair.key) && each.from[0] === pair.key.value,
    );
    return move ? [{ pair: pair as Pair<Scalar, Scalar>, move }] : [];
  });
  if (!moved.length) return [];
  const changes = moved.map(
    ({ move }) =>
      `${[...at, move.from[0]].join(".")} -> ${[...at, ...move.to].join(".")}`,
  );
  return service.flow
    ? moveInFlow(service, text, moved, changes)
    : moveInBlock(text, moved, changes);
}
/** Block style: each moved setting is whole lines, with the comment lines just above it at its indentation; they move as
 * they are, two spaces deeper, under the block's key, which takes the first one's place. */
function moveInBlock(
  text: string,
  moved: readonly Moved[],
  changes: readonly string[],
): TextEdit[] {
  const firstKey = moved[0]!.pair.key;
  const indent = " ".repeat(
    firstKey.range![0] - lineStart(text, firstKey.range![0]),
  );
  const chunks = moved.map(({ pair, move }) => {
    const key = pair.key;
    let start = lineStart(text, key.range![0]);
    while (start > 0) {
      const previous = lineStart(text, start - 1);
      if (!text.slice(previous, start).startsWith(`${indent}#`)) break;
      start = previous;
    }
    const valueEnd = pair.value?.range?.[1] ?? 0;
    const end = lineEnd(text, Math.max(key.range![1], valueEnd - 1));
    const renamed =
      text.slice(start, key.range![0]) +
      keyLike(key, move.to[1]) +
      text.slice(key.range![1], end);
    return { start, end, text: renamed.replace(/^(?=.)/gm, "  ") };
  });
  const block = `${indent}${keyLike(firstKey, moved[0]!.move.to[0])}:\n${chunks.map((chunk) => chunk.text).join("")}`;
  return chunks.map((chunk, index) => ({
    start: chunk.start,
    end: chunk.end,
    text: index === 0 ? block : "",
    ...(index === 0 ? { changes } : {}),
  }));
}
/** Flow style: the block, a flow mapping padded as its Service is, takes the first moved setting's place, and each value
 * keeps its source text. A later moved setting goes with the comma before it. */
function moveInFlow(
  service: YAMLMap,
  text: string,
  moved: readonly Moved[],
  changes: readonly string[],
): TextEdit[] {
  const padded = /^\{\s/.test(text.slice(service.range![0]));
  const [open, close] = padded ? ["{ ", " }"] : ["{", "}"];
  const valueText = ({ pair }: Moved) =>
    text.slice(pair.value!.range![0], pair.value!.range![1]);
  const first = moved[0]!;
  const block = `${keyLike(first.pair.key, first.move.to[0])}: ${open}${moved
    .map(
      (each) =>
        `${keyLike(each.pair.key, each.move.to[1])}: ${valueText(each)}`,
    )
    .join(", ")}${close}`;
  return moved.map((each, index) => {
    const end = each.pair.value!.range![1];
    const start =
      index === 0
        ? each.pair.key.range![0]
        : text.lastIndexOf(",", each.pair.key.range![0] - 1);
    if (index > 0 && text.slice(start, end).includes("#"))
      throw new ConfigError(
        "Moving this setting would drop a comment inside a flow mapping.",
        "upgrade_lossy",
        { setting: each.move.from[0] },
        `Move the comment out of the { ... } mapping that holds ${each.move.from[0]}, or write the mapping in block style, then run rig config upgrade again.`,
      );
    return {
      start,
      end,
      text: index === 0 ? block : "",
      ...(index === 0 ? { changes } : {}),
    };
  });
}
