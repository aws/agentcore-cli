import {
  MemoryRecordOperatorType,
  OperatorType,
  type EventMetadataFilterExpression,
  type MemoryMetadataFilterExpression,
} from "@aws-sdk/client-bedrock-agentcore";
import z from "zod";
import { parseJsonFlagWithSchema } from "../utils";

const eventMetadataValueSchema = z.object({ stringValue: z.string() }).strict();

const eventMetadataFilterExpressionSchema = z
  .object({
    left: z.object({ metadataKey: z.string().min(1) }).strict(),
    operator: z.enum(OperatorType),
    right: z.object({ metadataValue: eventMetadataValueSchema }).strict().optional(),
  })
  .strict()
  .superRefine((expression, ctx) => {
    if (expression.operator === OperatorType.EQUALS_TO && expression.right === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["right"],
        message: "right is required for EQUALS_TO",
      });
    }
  });

const memoryRecordMetadataValueSchema = z.union([
  z.object({ stringValue: z.string() }).strict(),
  z.object({ stringListValue: z.array(z.string()) }).strict(),
  z.object({ numberValue: z.number() }).strict(),
  z.object({ dateTimeValue: z.coerce.date() }).strict(),
]);

const memoryMetadataFilterExpressionSchema = z
  .object({
    left: z.object({ metadataKey: z.string().min(1) }).strict(),
    operator: z.enum(MemoryRecordOperatorType),
    right: z.object({ metadataValue: memoryRecordMetadataValueSchema }).strict().optional(),
  })
  .strict()
  .superRefine((expression, ctx) => {
    if (
      expression.operator !== MemoryRecordOperatorType.EXISTS &&
      expression.operator !== MemoryRecordOperatorType.NOT_EXISTS &&
      expression.right === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["right"],
        message: `right is required for ${expression.operator}`,
      });
    }
  });

const eventMetadataFiltersSchema: z.ZodType<EventMetadataFilterExpression[]> = z.array(
  eventMetadataFilterExpressionSchema,
);

const memoryMetadataFiltersSchema: z.ZodType<MemoryMetadataFilterExpression[]> = z.array(
  memoryMetadataFilterExpressionSchema,
);

export function parseEventMetadataFilters(
  raw: string | undefined,
): EventMetadataFilterExpression[] | undefined {
  return parseJsonFlagWithSchema("metadata-filters", raw, eventMetadataFiltersSchema);
}

export function parseMemoryMetadataFilters(
  raw: string | undefined,
): MemoryMetadataFilterExpression[] | undefined {
  return parseJsonFlagWithSchema("metadata-filters", raw, memoryMetadataFiltersSchema);
}
