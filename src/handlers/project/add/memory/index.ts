import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { parseJsonFlag } from "../../../utils";
import { InputValidationError } from "../../../../errors";
import type {
  IndexedKey as SdkIndexedKey,
  MemoryStrategyInput,
  StreamDeliveryResources as SdkStreamDeliveryResources,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  IndexedKeyTypeSchema,
  MemoryStrategyTypeSchema,
  StreamContentLevelSchema,
  type IndexedKey,
  type MemoryStrategy,
  type StreamDeliveryResources,
} from "../../../../projectSchemas/memory";

// The service default for raw event retention, applied when --event-expiry-duration
// is omitted so the common case is a single --name.
const DEFAULT_EVENT_EXPIRY_DURATION = 30;

const strategiesHelp = `(comma-separated list of strategy types, or JSON MemoryStrategyInput[])
The long-term memory strategies to extract from raw events. Accepts two forms.

Shorthand — a comma-separated list of strategy types, each expanded with its
default namespace templates:
  --strategies SEMANTIC,SUMMARIZATION

JSON — a MemoryStrategyInput[] mirroring the CreateMemory API, for strategies
that need explicit names, descriptions, or namespaces. Exactly one of the
following keys can be set per entry: semanticMemoryStrategy,
summaryMemoryStrategy, userPreferenceMemoryStrategy, episodicMemoryStrategy.

JSON syntax:
  [
    {
      "semanticMemoryStrategy": {
        "name": "string",
        "description": "string",
        "namespaceTemplates": ["string", ...]
      }
    },
    {
      "episodicMemoryStrategy": {
        "name": "string",
        "namespaceTemplates": ["string", ...],
        "reflectionConfiguration": {
          "namespaceTemplates": ["string", ...]  // [required] for EPISODIC; each
                                                 // must prefix a namespaceTemplate
        }
      }
    }
  ]

Example:
  --strategies '[{"semanticMemoryStrategy":{"name":"facts","namespaceTemplates":["/users/{actorId}/facts"]}}]'`;

export const createAddMemoryHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "memory",
    description: "adds a memory to the current project",
    flags: [
      flag("name", "the name of the memory", z.string().optional()),
      flag(
        "event-expiry-duration",
        "how long raw events are retained, in days (3-365)",
        z.number().int().min(3).max(365).default(DEFAULT_EVENT_EXPIRY_DURATION),
      ),
      flag(
        "strategies",
        "long-term memory strategies: comma-separated types, or JSON MemoryStrategyInput[]",
        z.string().optional(),
        { help: strategiesHelp },
      ),
      flag(
        "indexed-keys",
        "metadata keys indexed for filtering (JSON IndexedKey[]); requires at least one strategy",
        z.string().optional(),
      ),
      flag(
        "stream-delivery-resources",
        "destinations memory records are streamed to (JSON StreamDeliveryResources)",
        z.string().optional(),
      ),
      flag(
        "encryption-key-arn",
        "customer managed KMS key ARN used to encrypt the memory",
        z.string().optional(),
      ),
      flag(
        "execution-role-arn",
        "IAM role the memory assumes; a default role is created when omitted",
        z.string().optional(),
      ),
      flag("tags", "tags to apply (JSON object of key/value strings)", z.string().optional()),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name)
        throw new InputValidationError("required option '--name <name>' not specified");

      const inputIndexedKeys = parseJsonFlag<SdkIndexedKey[]>(
        "indexed-keys",
        flags["indexed-keys"],
      );
      const inputStreamDelivery = parseJsonFlag<SdkStreamDeliveryResources>(
        "stream-delivery-resources",
        flags["stream-delivery-resources"],
      );

      const memoryConfig = {
        name: flags.name,
        eventExpiryDuration: flags["event-expiry-duration"],
        strategies: flags["strategies"] ? toStrategies(flags["strategies"]) : undefined,
        indexedKeys: inputIndexedKeys?.map(toIndexedKey),
        encryptionKeyArn: flags["encryption-key-arn"],
        executionRoleArn: flags["execution-role-arn"],
        streamDeliveryResources: inputStreamDelivery
          ? toStreamDeliveryResources(inputStreamDelivery)
          : undefined,
        tags: parseJsonFlag<Record<string, string>>("tags", flags["tags"]),
      };

      const project = ctx.require(ProjectKey);
      for await (const event of config.projectManager.addResource(project, {
        resourceType: "memory",
        resourceConfig: memoryConfig,
      })) {
        config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added memory '${flags["name"]}' to '${project.name}'\n`);
    },
  });

/**
 * Parses --strategies, which accepts either a comma-separated list of strategy
 * types (expanded with the CLI's default namespaces) or a JSON
 * MemoryStrategyInput[] mirroring the CreateMemory API. A leading '[' selects the
 * JSON form; anything else is read as the shorthand.
 */
function toStrategies(raw: string): MemoryStrategy[] {
  if (raw.trimStart().startsWith("[")) {
    const inputs = parseJsonFlag<MemoryStrategyInput[]>("strategies", raw) ?? [];
    if (!Array.isArray(inputs))
      throw new InputValidationError("Option '--strategies' JSON must be an array");
    return inputs.map(toStrategy);
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(toDefaultStrategy);
}

/** Expands a bare strategy type into a strategy carrying its default namespaces. */
function toDefaultStrategy(type: string): MemoryStrategy {
  const parsed = MemoryStrategyTypeSchema.safeParse(type);
  if (!parsed.success)
    throw new InputValidationError(
      `unrecognized memory strategy '${type}'; expected one of ${MemoryStrategyTypeSchema.options.join(", ")}`,
    );

  return {
    type: parsed.data,
    namespaceTemplates: DEFAULT_STRATEGY_NAMESPACE_TEMPLATES[parsed.data],
    // EPISODIC additionally requires reflection namespaces; the defaults are
    // prefixes of the default episode namespaces, as the schema demands.
    ...(parsed.data === "EPISODIC" && {
      reflectionNamespaceTemplates: DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
    }),
  };
}

/** Converts an SDK MemoryStrategyInput tagged union into the flat project-schema shape. */
function toStrategy(strategy: MemoryStrategyInput): MemoryStrategy {
  if ("semanticMemoryStrategy" in strategy && strategy.semanticMemoryStrategy)
    return { type: "SEMANTIC", ...commonStrategyFields(strategy.semanticMemoryStrategy) };
  if ("summaryMemoryStrategy" in strategy && strategy.summaryMemoryStrategy)
    return { type: "SUMMARIZATION", ...commonStrategyFields(strategy.summaryMemoryStrategy) };
  if ("userPreferenceMemoryStrategy" in strategy && strategy.userPreferenceMemoryStrategy)
    return {
      type: "USER_PREFERENCE",
      ...commonStrategyFields(strategy.userPreferenceMemoryStrategy),
    };
  if ("episodicMemoryStrategy" in strategy && strategy.episodicMemoryStrategy) {
    const c = strategy.episodicMemoryStrategy;
    return {
      type: "EPISODIC",
      ...commonStrategyFields(c),
      reflectionNamespaceTemplates: c.reflectionConfiguration?.namespaceTemplates,
      reflectionNamespaces: c.reflectionConfiguration?.namespaces,
    };
  }
  // The project spec models the four managed strategy types; a custom strategy has
  // no representation in it (and no L3 construct to synthesize from).
  if ("customMemoryStrategy" in strategy && strategy.customMemoryStrategy)
    throw new InputValidationError(
      `customMemoryStrategy is not supported in a project spec; expected one of ${MemoryStrategyTypeSchema.options.join(", ")}`,
    );
  throw new InputValidationError("Unrecognized memory strategy variant");
}

/** The fields every SDK memory strategy variant shares, in project-schema terms. */
function commonStrategyFields(strategy: {
  name?: string;
  description?: string;
  namespaces?: string[];
  namespaceTemplates?: string[];
}) {
  return {
    name: strategy.name,
    description: strategy.description,
    namespaceTemplates: strategy.namespaceTemplates,
    namespaces: strategy.namespaces,
  };
}

/** Converts an SDK IndexedKey into the project-schema shape. */
function toIndexedKey(indexedKey: SdkIndexedKey): IndexedKey {
  const type = IndexedKeyTypeSchema.safeParse(indexedKey.type);
  if (!type.success)
    throw new InputValidationError(
      `indexedKeys[].type must be one of ${IndexedKeyTypeSchema.options.join(", ")}`,
    );
  return { key: requireField(indexedKey.key, "indexedKeys[].key"), type: type.data };
}

/** Converts an SDK StreamDeliveryResources into the project-schema shape. */
function toStreamDeliveryResources(
  streamDelivery: SdkStreamDeliveryResources,
): StreamDeliveryResources {
  const resources = requireField(streamDelivery.resources, "streamDeliveryResources.resources").map(
    (resource) => {
      if (!("kinesis" in resource) || !resource.kinesis)
        throw new InputValidationError("Unrecognized stream delivery resource variant");
      const kinesis = resource.kinesis;
      return {
        kinesis: {
          dataStreamArn: requireField(kinesis.dataStreamArn, "kinesis.dataStreamArn"),
          contentConfigurations: requireField(
            kinesis.contentConfigurations,
            "kinesis.contentConfigurations",
          ).map((content) => {
            if (content.type !== "MEMORY_RECORDS")
              throw new InputValidationError(
                `contentConfigurations[].type must be MEMORY_RECORDS, got '${String(content.type)}'`,
              );
            const level = StreamContentLevelSchema.safeParse(content.level);
            if (!level.success)
              throw new InputValidationError(
                `contentConfigurations[].level must be one of ${StreamContentLevelSchema.options.join(", ")}`,
              );
            return { type: "MEMORY_RECORDS" as const, level: level.data };
          }),
        },
      };
    },
  );

  return { resources };
}

/** Validates a required field is present, throwing with context instead of crashing opaquely. */
function requireField<T>(value: T | undefined | null, field: string): T {
  if (value == null) throw new InputValidationError(`${field} is required`);
  return value;
}
