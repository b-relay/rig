import {
  Document,
  isMap,
  isPair,
  isScalar,
  parseDocument,
  Pair,
  Scalar,
  visit,
  YAMLMap,
} from "yaml";
import {
  LATEST_FORMAT,
  movedReference,
  stepsFrom,
  type ConfigFormat,
  type FormatStep,
} from "./formats";
import { rewriteReferences } from "./references";

/** Pure: the text of a validated rig.yaml written in `format`, rewritten into the latest format, and what changed in words,
 * one line each. Only what the format change needs is touched, as text: `format` is set, every `${...}` reference to a moved
 * setting follows it, and each moved Service setting (in every Service and every role's Service patch) moves into its block
 * with the comment lines above it and its trailing comment. Every other byte stays as it was: comments, order, quoting,
 * blank lines, flow style and line length. Nothing changes for the latest format. The caller checks that the result parses
 * to the same config. */
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
  pass((document) => setFormat(document, text, format));
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

/** One replacement of source text, and the change it makes in words. */
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
  const change = `format: ${LATEST_FORMAT} (added; a file without it is ${format})`;
  if (root.flow)
    return [
      renderedFlow(root, text, [change], (map) =>
        map.items.unshift(
          new Pair(new Scalar("format"), new Scalar(LATEST_FORMAT)),
        ),
      ),
    ];
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
    if (
      /^#\s*yaml-language-server:/.test(text.slice(line, lineEnd(text, line)))
    )
      insert = lineEnd(text, line);
  return [
    {
      start: insert,
      end: insert,
      text: `format: ${LATEST_FORMAT}\n`,
      changes: [change],
    },
  ];
}

/** Every `${...}` reference to a moved setting, in any string value, spelled the way the step spells it. The key is
 * replaced inside the value's own source text, so its quoting stays. */
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
      edits.push({
        start,
        end,
        text: rewriteReferences(text.slice(start, end), rename),
        changes: [`${dotted(path, key)}: ${node.value} -> ${next}`],
      });
    },
  });
  return edits;
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

/** Moves the step's settings of one Service into their block, which takes the place of the first one moved. */
function moveSettings(
  service: YAMLMap,
  at: readonly string[],
  text: string,
  step: FormatStep,
): TextEdit[] {
  const moved = service.items.flatMap((pair) => {
    const move = step.moves.find(
      (each) => isScalar(pair.key) && each.from[0] === pair.key.value,
    );
    return move ? [{ pair, move }] : [];
  });
  if (!moved.length) return [];
  const changes = moved.map(
    ({ move }) =>
      `${[...at, move.from[0]].join(".")} -> ${[...at, ...move.to].join(".")}`,
  );
  if (service.flow)
    return [
      renderedFlow(service, text, changes, (map) => moveInTree(map, step)),
    ];
  // Block style: each moved setting is whole lines, with the comment lines just above it at its indentation; they move as
  // they are, two spaces deeper, under the block's key, which takes the first one's place.
  const firstKey = moved[0]!.pair.key as Scalar;
  const indent = " ".repeat(
    firstKey.range![0] - lineStart(text, firstKey.range![0]),
  );
  const chunks = moved.map(({ pair, move }) => {
    const key = pair.key as Scalar;
    let start = lineStart(text, key.range![0]);
    while (start > 0) {
      const previous = lineStart(text, start - 1);
      if (!text.slice(previous, start).startsWith(`${indent}#`)) break;
      start = previous;
    }
    const valueEnd = (pair.value as Scalar | null)?.range?.[1] ?? 0;
    const end = lineEnd(text, Math.max(key.range![1], valueEnd - 1));
    const renamed =
      text.slice(start, key.range![0]) +
      move.to[1] +
      text.slice(key.range![1], end);
    return { start, end, text: renamed.replace(/^(?=.)/gm, "  ") };
  });
  const block = `${indent}${moved[0]!.move.to[0]}:\n${chunks.map((chunk) => chunk.text).join("")}`;
  return chunks.map((chunk, index) => ({
    start: chunk.start,
    end: chunk.end,
    text: index === 0 ? block : "",
    ...(index === 0 ? { changes } : {}),
  }));
}
/** The step's moves on one Service mapping of a syntax tree: the block takes the first moved setting's place. */
function moveInTree(service: YAMLMap, step: FormatStep): void {
  const kept: typeof service.items = [];
  let block: YAMLMap | undefined;
  for (const pair of service.items) {
    const move = step.moves.find(
      (each) => isScalar(pair.key) && each.from[0] === pair.key.value,
    );
    if (!move) {
      kept.push(pair);
      continue;
    }
    if (!block) {
      block = new YAMLMap();
      block.flow = true;
      kept.push(new Pair(new Scalar(move.to[0]), block));
    }
    block.items.push(new Pair(new Scalar(move.to[1]), pair.value));
  }
  service.items = kept;
}
/** A flow mapping, changed by `change` on its tree and written again in place, with the padding its source used. */
function renderedFlow(
  map: YAMLMap,
  text: string,
  changes: readonly string[],
  change: (map: YAMLMap) => void,
): TextEdit {
  const [start, end] = map.range!;
  const source = text.slice(start, end);
  change(map);
  const rendered = new Document(map)
    .toString({
      lineWidth: 0,
      flowCollectionPadding: /^\{\s/.test(source),
    })
    .trimEnd();
  return { start, end, text: rendered, changes };
}
