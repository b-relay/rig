import { isAlias, isMap, isScalar, parseAllDocuments, visit } from "yaml";
import { ConfigError } from "./errors";

/** Pure YAML 1.2 parser. Restrictions run on the syntax tree before domain validation. */
export function yamlDocument(raw: string, path: string) {
  const documents = parseAllDocuments(raw, {
    version: "1.2",
    uniqueKeys: true,
    strict: true,
  });
  if (documents.length !== 1)
    throw new ConfigError(
      "Config must contain exactly one YAML document.",
      "invalid_yaml",
      { path },
      "Write the config as one YAML document: remove any later '---' separator, or add the config if the file is empty.",
    );
  const document = documents[0]!;
  if (document.directives?.yaml.version !== "1.2")
    throw new ConfigError(
      "Config must use YAML 1.2.",
      "invalid_yaml",
      { path },
      "Remove the %YAML directive, or make it %YAML 1.2.",
    );
  if (document.errors.length || document.warnings.length)
    throw new ConfigError(
      "Invalid or unsupported YAML syntax.",
      "invalid_yaml",
      { path },
      "Fix the YAML syntax, such as a key given twice, an unclosed bracket or a custom tag, then retry.",
    );
  visit(document, (_key, node) => {
    if (
      isAlias(node) ||
      (typeof node === "object" &&
        node !== null &&
        (("anchor" in node && node.anchor) || ("tag" in node && node.tag)))
    )
      throw new ConfigError(
        "YAML anchors, aliases, and explicit tags are unsupported.",
        "invalid_yaml",
        { path },
        "Write each value out in full, without an anchor (&), alias (*) or tag (!).",
      );
    if (isMap(node))
      for (const item of node.items)
        if (isScalar(item.key) && item.key.value === "<<")
          throw new ConfigError(
            "YAML merge keys are unsupported.",
            "invalid_yaml",
            { path },
            "Replace each '<<' key with the keys it would merge.",
          );
  });
  return document;
}
/** Pure: the value a config document's text holds, for domain validation; `invalid_yaml` or `invalid_syntax` otherwise. */
export function yamlValue(raw: string, path: string): unknown {
  try {
    return yamlDocument(raw, path).toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      "Unable to parse config document.",
      "invalid_syntax",
      { path },
      "Fix the YAML syntax, then retry.",
    );
  }
}
