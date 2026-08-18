import { z } from "zod";
import { TagsSchema } from "./tags";
import { uniqueBy } from "./zod-util";
export const MemoryStrategyTypeSchema = z.enum([
  "SEMANTIC",
  "SUMMARIZATION",
  "USER_PREFERENCE",
  "EPISODIC",
]);
export type MemoryStrategyType = z.infer<typeof MemoryStrategyTypeSchema>;
export const DEFAULT_STRATEGY_NAMESPACE_TEMPLATES: Partial<Record<MemoryStrategyType, string[]>> = {
  SEMANTIC: ["/users/{actorId}/facts"],
  USER_PREFERENCE: ["/users/{actorId}/preferences"],
  SUMMARIZATION: ["/summaries/{actorId}/{sessionId}"],
  EPISODIC: ["/episodes/{actorId}/{sessionId}"],
};
export const DEFAULT_STRATEGY_NAMESPACES = DEFAULT_STRATEGY_NAMESPACE_TEMPLATES;
export const DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES: string[] = ["/episodes/{actorId}"];
export const DEFAULT_EPISODIC_REFLECTION_NAMESPACES =
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES;
export const MemoryStrategyNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
export const MemoryStrategySchema = z
  .object({
    type: MemoryStrategyTypeSchema,
    name: MemoryStrategyNameSchema.optional(),
    description: z.string().optional(),
    namespaceTemplates: z.array(z.string()).optional(),
    namespaces: z.array(z.string()).optional(),
    reflectionNamespaceTemplates: z.array(z.string()).optional(),
    reflectionNamespaces: z.array(z.string()).optional(),
  })
  .refine(
    (strategy) =>
      !((strategy.namespaces?.length ?? 0) > 0 && (strategy.namespaceTemplates?.length ?? 0) > 0),
    {
      message:
        "'namespaces' and 'namespaceTemplates' are mutually exclusive. Prefer 'namespaceTemplates' ('namespaces' is deprecated).",
      path: ["namespaceTemplates"],
    },
  )
  .refine(
    (strategy) =>
      !(
        (strategy.reflectionNamespaces?.length ?? 0) > 0 &&
        (strategy.reflectionNamespaceTemplates?.length ?? 0) > 0
      ),
    {
      message:
        "'reflectionNamespaces' and 'reflectionNamespaceTemplates' are mutually exclusive. Prefer 'reflectionNamespaceTemplates' ('reflectionNamespaces' is deprecated).",
      path: ["reflectionNamespaceTemplates"],
    },
  )
  .refine(
    (strategy) =>
      strategy.type === "EPISODIC" ||
      (strategy.reflectionNamespaceTemplates === undefined &&
        strategy.reflectionNamespaces === undefined),
    {
      message: "'reflectionNamespaceTemplates' is only allowed on EPISODIC strategies",
      path: ["reflectionNamespaceTemplates"],
    },
  )
  .refine(
    (strategy) => {
      if (strategy.type !== "EPISODIC") return true;
      const reflection = strategy.reflectionNamespaceTemplates ?? strategy.reflectionNamespaces;
      return reflection !== undefined && reflection.length > 0;
    },
    {
      message: "EPISODIC strategy requires reflectionNamespaceTemplates",
      path: ["reflectionNamespaceTemplates"],
    },
  )
  .refine(
    (strategy) => {
      if (strategy.type !== "EPISODIC") return true;
      const reflection = strategy.reflectionNamespaceTemplates ?? strategy.reflectionNamespaces;
      const templates = strategy.namespaceTemplates ?? strategy.namespaces;
      if (!reflection || !templates) return true;
      return reflection.every((ref) => templates.some((ns) => ns.startsWith(ref)));
    },
    {
      message:
        "Each reflectionNamespaceTemplate must be a prefix of at least one namespaceTemplate",
      path: ["reflectionNamespaceTemplates"],
    },
  );
export type MemoryStrategy = z.infer<typeof MemoryStrategySchema>;
export const MemoryTypeSchema = z.literal("AgentCoreMemory");
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export const MemoryNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
export const StreamContentLevelSchema = z.enum(["FULL_CONTENT", "METADATA_ONLY"]);
export type StreamContentLevel = z.infer<typeof StreamContentLevelSchema>;
export const StreamDeliveryResourcesSchema = z.object({
  resources: z
    .array(
      z.object({
        kinesis: z.object({
          dataStreamArn: z.string().min(1),
          contentConfigurations: z
            .array(
              z.object({
                type: z.literal("MEMORY_RECORDS"),
                level: StreamContentLevelSchema,
              }),
            )
            .min(1),
        }),
      }),
    )
    .min(1),
});
export type StreamDeliveryResources = z.infer<typeof StreamDeliveryResourcesSchema>;
export const IndexedKeyTypeSchema = z.enum(["STRING", "STRINGLIST", "NUMBER"]);
export type IndexedKeyType = z.infer<typeof IndexedKeyTypeSchema>;
export const INDEXED_KEY_NAME_PATTERN = /^[a-zA-Z0-9\s._:/=+@-]+$/;
export const INDEXED_KEY_NAME_PATTERN_MESSAGE =
  "Must contain only alphanumeric characters, whitespace, or the symbols . _ : / = + @ -";
export const MAX_INDEXED_KEY_NAME_LENGTH = 128;
export const MAX_INDEXED_KEYS = 10;
export const IndexedKeySchema = z.object({
  key: z
    .string()
    .min(1)
    .max(MAX_INDEXED_KEY_NAME_LENGTH)
    .regex(INDEXED_KEY_NAME_PATTERN, INDEXED_KEY_NAME_PATTERN_MESSAGE)
    .refine((value) => value.trim().length > 0, "Key cannot be only whitespace"),
  type: IndexedKeyTypeSchema,
});
export type IndexedKey = z.infer<typeof IndexedKeySchema>;
export const MEMORY_DESCRIPTION_MAX_LENGTH = 4096;
export const MemorySchema = z
  .object({
    name: MemoryNameSchema,
    description: z.string().min(1).max(MEMORY_DESCRIPTION_MAX_LENGTH).optional(),
    eventExpiryDuration: z.number().int().min(3).max(365),
    strategies: z
      .array(MemoryStrategySchema)
      .default([])
      .superRefine(
        uniqueBy(
          (strategy) => strategy.type,
          (type) => `Duplicate memory strategy type: ${type}`,
        ),
      ),
    indexedKeys: z
      .array(IndexedKeySchema)
      .max(MAX_INDEXED_KEYS)
      .superRefine(
        uniqueBy(
          (entry) => entry.key,
          (key) => `Duplicate indexed key: ${key}`,
        ),
      )
      .optional(),
    tags: TagsSchema.optional(),
    encryptionKeyArn: z.string().optional(),
    executionRoleArn: z.string().optional(),
    streamDeliveryResources: StreamDeliveryResourcesSchema.optional(),
  })
  .superRefine((memory, ctx) => {
    if (memory.indexedKeys && memory.indexedKeys.length > 0 && memory.strategies.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["indexedKeys"],
        message: "indexedKeys requires at least one memory strategy (long-term memory)",
      });
    }
  });
export type Memory = z.infer<typeof MemorySchema>;
