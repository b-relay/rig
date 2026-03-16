import { Effect } from "effect"

import { Logger } from "../interfaces/logger.js"
import { CliArgumentError } from "../schema/errors.js"
import {
  ONBOARDING_TOPIC_MAP,
  renderOnboardingTopic,
  renderOnboardingTopicList,
  type OnboardingTopicId,
} from "./onboarding-docs.js"
import { CONFIG_FIELD_MAP, CONFIG_FIELDS, type ConfigFieldInfo } from "./config-fields.js"

const formatFieldSummary = (field: ConfigFieldInfo): string =>
  `${field.key} (${field.valueType}${field.settable ? ", settable" : ""}): ${field.shortDescription}`

const formatFieldDetails = (field: ConfigFieldInfo): string[] => [
  field.key,
  `Type: ${field.valueType}`,
  `Settable: ${field.settable ? "yes" : "no"}`,
  `Unsettable: ${field.unsettable ? "yes" : "no"}`,
  "",
  field.description,
]

export const runDocsCommand = (topic?: "config" | "onboard", key?: string) =>
  Effect.gen(function* () {
    const logger = yield* Logger

    if (!topic) {
      yield* logger.info(
        [
          "Docs",
          "  config  rig.json schema keys, value types, and settable paths",
          "  onboard rig-first starter recipes for common app shapes",
          "",
          "Run `rig docs <topic>` for a topic overview.",
        ].join("\n"),
      )

      return 0
    }

    if (topic === "onboard") {
      if (!key) {
        yield* logger.info(renderOnboardingTopicList().join("\n"))
        return 0
      }

      const onboardingTopic = ONBOARDING_TOPIC_MAP.get(key as OnboardingTopicId)
      if (!onboardingTopic) {
        return yield* Effect.fail(
          new CliArgumentError(
            "docs",
            `Unknown onboarding docs topic '${key}'.`,
            "Run `rig docs onboard` to see available onboarding topics.",
            { key },
          ),
        )
      }

      yield* logger.info(renderOnboardingTopic(onboardingTopic))
      return 0
    }

    if (!key) {
      yield* logger.info(
        [
          "Config Docs",
          "  `settable` means this key supports `rig config set` directly.",
          "  Non-settable keys can still be edited manually in rig.json unless a key-specific warning says extra rig state also needs to change.",
          "  Use `rig config set <name> <key> null` to write JSON null for nullable keys.",
          "  Use `rig config unset <name> <key>` to remove optional keys.",
        ].join("\n"),
      )

      for (const field of CONFIG_FIELDS) {
        yield* logger.info(formatFieldSummary(field))
      }

      return 0
    }

    const field = CONFIG_FIELD_MAP.get(key)
    if (!field) {
      return yield* Effect.fail(
        new CliArgumentError(
          "docs",
          `Unknown config docs key '${key}'.`,
          "Run `rig docs config` to see available keys.",
          { key },
        ),
      )
    }

    const lines = formatFieldDetails(field)

    if (field.settable || field.nullable || field.unsettable) {
      lines.push("", "CLI:")
      if (field.settable) {
        lines.push(`  rig config set <name> ${field.key} <value>`)
      }
      if (field.nullable) {
        lines.push(`  rig config set <name> ${field.key} null`)
      }
      if (field.unsettable) {
        lines.push(`  rig config unset <name> ${field.key}`)
      }
    }

    if (field.manualEditWarning) {
      lines.push("", `Manual Edit Warning: ${field.manualEditWarning}`)
    }

    if (field.children.length > 0) {
      lines.push("", "Child Keys:")
      for (const childKey of field.children) {
        const child = CONFIG_FIELD_MAP.get(childKey)
        if (!child) {
          continue
        }
        lines.push(`  ${formatFieldSummary(child)}`)
      }
    }

    yield* logger.info(lines.join("\n"))
    return 0
  })
