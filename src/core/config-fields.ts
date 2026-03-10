import { z } from "zod"

import { RigConfigSchema } from "../schema/config.js"

interface ConfigFieldRecord {
  key: string
  valueType: string
  shortDescription: string
  description: string
  settable: boolean
  unsettable: boolean
  nullable: boolean
  optional: boolean
  manualEditWarning?: string
  parent?: string
}

export interface ConfigFieldInfo {
  readonly key: string
  readonly valueType: string
  readonly shortDescription: string
  readonly description: string
  readonly settable: boolean
  readonly unsettable: boolean
  readonly nullable: boolean
  readonly optional: boolean
  readonly manualEditWarning?: string
  readonly children: readonly string[]
}

type ZodLike = any

const unwrapSchema = (schema: ZodLike): ZodLike => {
  let current = schema

  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = current.unwrap()
  }

  return current
}

const isNullable = (schema: ZodLike): boolean =>
  schema instanceof z.ZodNullable
    ? true
    : schema instanceof z.ZodOptional || schema instanceof z.ZodDefault
      ? isNullable(schema.unwrap())
      : false

const isOptional = (schema: ZodLike): boolean =>
  schema instanceof z.ZodOptional
    ? true
    : schema instanceof z.ZodNullable || schema instanceof z.ZodDefault
      ? isOptional(schema.unwrap())
      : false

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim()

const toShortDescription = (schema: ZodLike, description: string): string => {
  const metadata = typeof schema.meta === "function" ? schema.meta() : undefined
  const fromMeta =
    metadata && typeof metadata === "object" && typeof metadata.shortDescription === "string"
      ? collapseWhitespace(metadata.shortDescription)
      : undefined

  if (fromMeta && fromMeta.length > 0) {
    return fromMeta
  }

  const normalized = collapseWhitespace(description)
  const firstSentenceEnd = normalized.search(/[.!?](?:\s|$)/)
  const sentence =
    firstSentenceEnd === -1 ? normalized : normalized.slice(0, firstSentenceEnd + 1)

  if (sentence.length <= 88) {
    return sentence
  }

  return `${sentence.slice(0, 85).trimEnd()}...`
}

const getLongDescription = (schema: ZodLike): string =>
  collapseWhitespace(schema.description ?? unwrapSchema(schema).description ?? "(no description available)")

const literalType = (schema: ZodLike): string => JSON.stringify(schema._def.values[0])

const enumType = (schema: ZodLike): string =>
  Object.values(schema.enum).map((value) => JSON.stringify(value)).join(" | ")

const primitiveValueType = (key: string, schema: ZodLike): string | null => {
  const unwrapped = unwrapSchema(schema)
  const suffix = isNullable(schema) ? " | null" : ""

  if (unwrapped instanceof z.ZodString) {
    return key === "version" ? `semver string${suffix}` : `string${suffix}`
  }

  if (unwrapped instanceof z.ZodNumber) {
    return `number${suffix}`
  }

  if (unwrapped instanceof z.ZodBoolean) {
    return `boolean${suffix}`
  }

  if (unwrapped instanceof z.ZodLiteral) {
    return `${literalType(unwrapped)}${suffix}`
  }

  if (unwrapped instanceof z.ZodEnum) {
    return `${enumType(unwrapped)}${suffix}`
  }

  return null
}

const containerValueType = (schema: ZodLike): string => {
  const unwrapped = unwrapSchema(schema)

  if (unwrapped instanceof z.ZodArray) {
    return "array"
  }

  if (unwrapped instanceof z.ZodObject || unwrapped instanceof z.ZodDiscriminatedUnion) {
    return "object"
  }

  const primitive = primitiveValueType("", schema)
  return primitive ?? "value"
}

const manualEditWarning = (key: string): string | undefined => {
  if (key === "name") {
    return "Changing the project name also requires updating the registry entry, workspace paths, installed bin names, and launchd labels."
  }

  if (key === "version") {
    return "Production release versions are tied to git tags, release history, and deployed prod workspaces. Use `rig deploy ... --bump ...`, `rig deploy ... --revert ...`, or `rig version ... --edit ...` instead of editing this field directly."
  }

  return undefined
}

const canSetDirectly = (key: string, schema: ZodLike): boolean =>
  key !== "name" &&
  key !== "version" &&
  !key.includes("[]") &&
  primitiveValueType(key, schema) !== null

const canUnsetDirectly = (key: string, schema: ZodLike): boolean =>
  key !== "name" &&
  key !== "version" &&
  !key.includes("[]") &&
  primitiveValueType(key, schema) !== null &&
  (isOptional(schema) || isNullable(schema))

const mergeValueTypes = (left: string, right: string): string => {
  if (left === right) {
    return left
  }

  const values = new Set(
    `${left} | ${right}`
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )

  return [...values].join(" | ")
}

const mergeDescriptions = (left: string, right: string): string => {
  if (left === right) {
    return left
  }

  return [...new Set([left, right])].join(" ")
}

const registerField = (
  fields: Map<string, ConfigFieldRecord>,
  schema: ZodLike,
  key: string,
  parent: string | undefined,
  valueType: string,
): void => {
  const description = getLongDescription(schema)
  const shortDescription = toShortDescription(schema, description)
  const nullable = isNullable(schema)
  const optional = isOptional(schema)
  const settable = canSetDirectly(key, schema)
  const unsettable = canUnsetDirectly(key, schema)
  const warning = manualEditWarning(key)
  const existing = fields.get(key)

  if (!existing) {
    fields.set(key, {
      key,
      valueType,
      shortDescription,
      description,
      settable,
      unsettable,
      nullable,
      optional,
      manualEditWarning: warning,
      parent,
    })
    return
  }

  fields.set(key, {
    ...existing,
    valueType: mergeValueTypes(existing.valueType, valueType),
    shortDescription: mergeDescriptions(existing.shortDescription, shortDescription),
    description: mergeDescriptions(existing.description, description),
    settable: existing.settable || settable,
    unsettable: existing.unsettable || unsettable,
    nullable: existing.nullable || nullable,
    optional: existing.optional || optional,
    manualEditWarning: existing.manualEditWarning ?? warning,
    parent: existing.parent ?? parent,
  })
}

const collectFields = (
  schema: ZodLike,
  fields: Map<string, ConfigFieldRecord>,
  prefix = "",
  parent?: string,
): void => {
  const unwrapped = unwrapSchema(schema)

  if (prefix) {
    registerField(
      fields,
      schema,
      prefix,
      parent,
      primitiveValueType(prefix, schema) ?? containerValueType(schema),
    )
  }

  if (unwrapped instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(unwrapped.shape)) {
      const childPath = prefix ? `${prefix}.${key}` : key
      collectFields(child, fields, childPath, prefix || undefined)
    }
    return
  }

  if (unwrapped instanceof z.ZodArray) {
    const elementPath = `${prefix}[]`
    collectFields(unwrapped.element, fields, elementPath, prefix || undefined)
    return
  }

  if (unwrapped instanceof z.ZodDiscriminatedUnion) {
    for (const option of unwrapped.options) {
      collectFields(option, fields, prefix, parent)
    }
    return
  }
}

const buildFieldCatalog = (): readonly ConfigFieldInfo[] => {
  const records = new Map<string, ConfigFieldRecord>()
  collectFields(RigConfigSchema, records)

  const childrenByParent = new Map<string, string[]>()
  for (const field of records.values()) {
    if (!field.parent) {
      continue
    }

    const children = childrenByParent.get(field.parent) ?? []
    if (!children.includes(field.key)) {
      children.push(field.key)
      childrenByParent.set(field.parent, children)
    }
  }

  return [...records.values()].map((field) => ({
    key: field.key,
    valueType: field.valueType,
    shortDescription: field.shortDescription,
    description: field.description,
    settable: field.settable,
    unsettable: field.unsettable,
    nullable: field.nullable,
    optional: field.optional,
    manualEditWarning: field.manualEditWarning,
    children: childrenByParent.get(field.key) ?? [],
  }))
}

export const CONFIG_FIELDS: readonly ConfigFieldInfo[] = buildFieldCatalog()

export const CONFIG_FIELD_MAP = new Map(
  CONFIG_FIELDS.map((field) => [field.key, field] as const),
)

export const SETTABLE_CONFIG_FIELDS = CONFIG_FIELDS.filter((field) => field.settable)
export const SETTABLE_CONFIG_FIELD_MAP = new Map(
  SETTABLE_CONFIG_FIELDS.map((field) => [field.key, field] as const),
)

export const UNSETTABLE_CONFIG_FIELDS = CONFIG_FIELDS.filter((field) => field.unsettable)
export const UNSETTABLE_CONFIG_FIELD_MAP = new Map(
  UNSETTABLE_CONFIG_FIELDS.map((field) => [field.key, field] as const),
)
