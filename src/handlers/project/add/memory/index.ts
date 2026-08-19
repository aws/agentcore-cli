import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { parseJsonFlagWithSchema } from "../../../utils";
import { InputValidationError } from "../../../../errors";
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  IndexedKeySchema,
  MemoryStrategyNameSchema,
  MemoryStrategyTypeSchema,
  StreamDeliveryResourcesSchema,
  type MemoryStrategy,
} from "../../../../projectSchemas/memory";
import { TagsSchema } from "../../../../projectSchemas/tags";

// The service default for raw event retention
const DEFAULT_EVENT_EXPIRY_DURATION = 30;

const strategyFields = {
  name: MemoryStrategyNameSchema.optional(),
  description: z.string().optional(),
  namespaces: z.array(z.string()).optional(),
  namespaceTemplates: z.array(z.string()).optional(),
};

function projectMemoryObject<T extends z.ZodRawShape>(shape: T, label: string) {
  const supportedFields = new Set(Object.keys(shape));
  return z
    .object(shape)
    .passthrough()
    .superRefine((value, ctx) => {
      for (const field of Object.keys(value)) {
        if (!supportedFields.has(field)) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${label} field '${field}' is not supported by project memory resources`,
          });
        }
      }
    });
}

const StandardStrategyInputSchema = projectMemoryObject(strategyFields, "memory strategy");
const EpisodicStrategyInputSchema = projectMemoryObject(
  {
    ...strategyFields,
    reflectionConfiguration: projectMemoryObject(
      {
        namespaces: z.array(z.string()).optional(),
        namespaceTemplates: z.array(z.string()).optional(),
      },
      "episodic reflection configuration",
    ).optional(),
  },
  "episodic memory strategy",
);

const STRATEGY_MEMBER_KEYS = [
  "semanticMemoryStrategy",
  "summaryMemoryStrategy",
  "userPreferenceMemoryStrategy",
  "episodicMemoryStrategy",
  "customMemoryStrategy",
] as const;

const MemoryStrategyInputSchema = projectMemoryObject(
  {
    semanticMemoryStrategy: StandardStrategyInputSchema.optional(),
    summaryMemoryStrategy: StandardStrategyInputSchema.optional(),
    userPreferenceMemoryStrategy: StandardStrategyInputSchema.optional(),
    episodicMemoryStrategy: EpisodicStrategyInputSchema.optional(),
    customMemoryStrategy: z.unknown().optional(),
  },
  "memory strategy input",
).superRefine((strategy, ctx) => {
  const members = STRATEGY_MEMBER_KEYS.filter((key) => strategy[key] !== undefined);
  if (members.length !== 1) {
    ctx.addIssue({
      code: "custom",
      message: `Exactly one memory strategy member must be specified; received ${members.length}`,
    });
  }
  if (members[0] === "customMemoryStrategy") {
    ctx.addIssue({
      code: "custom",
      path: ["customMemoryStrategy"],
      message: "customMemoryStrategy is not supported by project memory resources",
    });
  }
});
type ProjectMemoryStrategyInput = z.infer<typeof MemoryStrategyInputSchema>;

const strategiesHelp = `(comma-separated list of strategy types, or JSON MemoryStrategyInput[])
The long-term memory strategies to extract from raw events. Accepts two forms.

Shorthand — a comma-separated list of strategy types, each expanded with its
default namespace templates:
  --strategies SEMANTIC,SUMMARIZATION

JSON — a MemoryStrategyInput[] mirroring the CreateMemory API, for strategies
that need explicit names, descriptions, or namespaces. Exactly one of the
following keys can be set per entry: semanticMemoryStrategy,
summaryMemoryStrategy, userPreferenceMemoryStrategy, episodicMemoryStrategy.

JSON example:
  [
    {
      "semanticMemoryStrategy": {
        "name": "facts",
        "description": "Durable user facts",
        "namespaceTemplates": ["/users/{actorId}/facts"]
      }
    },
    {
      "episodicMemoryStrategy": {
        "name": "episodes",
        "namespaceTemplates": ["/episodes/{actorId}/{sessionId}"],
        "reflectionConfiguration": {
          "namespaceTemplates": ["/episodes/{actorId}"]
        }
      }
    }
  ]`;

export const createAddMemoryHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "memory",
    description: "adds a memory to the current project",
    flags: [
      flag("name", "the name of the memory", z.string().optional()),
      flag("description", "a description of what the memory stores", z.string().optional()),
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

      const inputIndexedKeys = parseJsonFlagWithSchema(
        "indexed-keys",
        flags["indexed-keys"],
        z.array(IndexedKeySchema),
      );
      const inputStreamDelivery = parseJsonFlagWithSchema(
        "stream-delivery-resources",
        flags["stream-delivery-resources"],
        StreamDeliveryResourcesSchema,
      );

      const memoryConfig = {
        name: flags.name,
        description: flags["description"],
        eventExpiryDuration: flags["event-expiry-duration"],
        strategies: flags["strategies"] ? toStrategies(flags["strategies"]) : undefined,
        indexedKeys: inputIndexedKeys,
        encryptionKeyArn: flags["encryption-key-arn"],
        executionRoleArn: flags["execution-role-arn"],
        streamDeliveryResources: inputStreamDelivery,
        tags: parseJsonFlagWithSchema("tags", flags["tags"], TagsSchema),
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
    const inputs =
      parseJsonFlagWithSchema("strategies", raw, z.array(MemoryStrategyInputSchema)) ?? [];
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
function toStrategy(strategy: ProjectMemoryStrategyInput): MemoryStrategy {
  if (strategy.semanticMemoryStrategy)
    return { type: "SEMANTIC", ...toProjectStrategyFields(strategy.semanticMemoryStrategy) };
  if (strategy.summaryMemoryStrategy)
    return { type: "SUMMARIZATION", ...toProjectStrategyFields(strategy.summaryMemoryStrategy) };
  if (strategy.userPreferenceMemoryStrategy)
    return {
      type: "USER_PREFERENCE",
      ...toProjectStrategyFields(strategy.userPreferenceMemoryStrategy),
    };
  if (strategy.episodicMemoryStrategy) {
    const c = strategy.episodicMemoryStrategy;
    return {
      type: "EPISODIC",
      ...toProjectStrategyFields(c),
      reflectionNamespaceTemplates: c.reflectionConfiguration?.namespaceTemplates,
      reflectionNamespaces: c.reflectionConfiguration?.namespaces,
    };
  }
  throw new InputValidationError("Unrecognized memory strategy variant");
}

/**
 * Picks only the fields the project schema supports from an SDK strategy variant.
 * The JSON input schema rejects unsupported fields before this conversion.
 */
function toProjectStrategyFields(strategy: {
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
