import z from "zod";
import { createHandler, flag, ProjectKey } from "../../../../router";
import type { AddProjectResourceConfig } from "../types";
import { parseJsonFlagWithSchema } from "../../../utils";
import { InputValidationError } from "../../../../errors";
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  IndexedKeySchema,
  MemoryStrategySchema,
  MemoryStrategyTypeSchema,
  StreamContentLevelSchema,
  type MemoryStrategy,
} from "../../../../projectSchemas/memory";
import { TagsSchema } from "../../../../projectSchemas/tags";

// The service default for raw event retention
const DEFAULT_EVENT_EXPIRY_DURATION = 30;

function projectMemoryObject<T extends z.ZodRawShape>(shape: T, label: string) {
  const supportedFields = new Set(Object.keys(shape));
  return z
    .unknown()
    .superRefine((value, ctx) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      for (const field of Object.keys(value)) {
        if (!supportedFields.has(field)) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${label} field '${field}' is not supported by project memory resources`,
          });
        }
      }
    })
    .pipe(z.object(shape));
}

/**
 * A --strategies JSON entry is an `agentcore.json` strategies entry verbatim, so
 * the project schema itself decides which fields and values are accepted and the
 * two cannot drift. The wrapper only adds the unsupported-field diagnostics.
 */
const MemoryStrategyInputSchema = projectMemoryObject(
  MemoryStrategySchema.shape,
  "memory strategy",
).pipe(MemoryStrategySchema);

const IndexedKeyInputSchema = projectMemoryObject(IndexedKeySchema.shape, "indexed key");
const StreamContentConfigurationInputSchema = projectMemoryObject(
  {
    type: z.literal("MEMORY_RECORDS"),
    level: StreamContentLevelSchema,
  },
  "stream content configuration",
);
const KinesisStreamDeliveryInputSchema = projectMemoryObject(
  {
    dataStreamArn: z.string().min(1),
    contentConfigurations: z.array(StreamContentConfigurationInputSchema).min(1),
  },
  "Kinesis stream delivery resource",
);
const StreamDeliveryResourceInputSchema = projectMemoryObject(
  {
    kinesis: KinesisStreamDeliveryInputSchema,
  },
  "stream delivery resource",
);
const StreamDeliveryResourcesInputSchema = projectMemoryObject(
  {
    resources: z.array(StreamDeliveryResourceInputSchema).min(1),
  },
  "stream delivery resources",
);

const strategiesHelp = `(comma-separated list of strategy types, or JSON strategies[])
The long-term memory strategies to extract from raw events. Accepts two forms.

Shorthand — a comma-separated list of strategy types, each expanded with its
default namespace templates:
  --strategies SEMANTIC,SUMMARIZATION

JSON — the memory's \`strategies\` array exactly as it is stored in
agentcore.json, for strategies that need explicit names, descriptions, or
namespaces. Per entry: \`type\` is required; \`name\`, \`description\` and
\`namespaceTemplates\` are optional; EPISODIC also takes
\`reflectionNamespaceTemplates\`, each of which must be a prefix of one of its
\`namespaceTemplates\`.

JSON example:
  [
    {
      "type": "SEMANTIC",
      "name": "facts",
      "description": "Durable user facts",
      "namespaceTemplates": ["/users/{actorId}/facts"]
    },
    {
      "type": "EPISODIC",
      "name": "episodes",
      "namespaceTemplates": ["/episodes/{actorId}/{sessionId}"],
      "reflectionNamespaceTemplates": ["/episodes/{actorId}"]
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
        "long-term memory strategies: comma-separated types, or the JSON strategies[] as stored in agentcore.json",
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
        z.array(IndexedKeyInputSchema),
      );
      const inputStreamDelivery = parseJsonFlagWithSchema(
        "stream-delivery-resources",
        flags["stream-delivery-resources"],
        StreamDeliveryResourcesInputSchema,
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
        if (event.type === "step") config.io.stderr.write(`${event.message}\n`);
      }

      config.io.stderr.write(`added memory '${flags["name"]}' to '${project.name}'\n`);
    },
  });

/**
 * Parses --strategies, which accepts either a comma-separated list of strategy
 * types (expanded with the CLI's default namespaces) or the project schema's
 * `strategies` array as JSON. A leading JSON container selects the JSON form;
 * anything else is read as the shorthand.
 */
function toStrategies(raw: string): MemoryStrategy[] {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{"))
    return parseJsonFlagWithSchema("strategies", raw, z.array(MemoryStrategyInputSchema)) ?? [];

  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0))
    throw new InputValidationError("memory strategy list cannot contain empty entries");
  return entries.map(toDefaultStrategy);
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
