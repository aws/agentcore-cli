import z from "zod";
import type { ComponentConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import type { SourceResolver } from "../../../io";
import { InputValidationError } from "../../../errors";
import { parseJsonFlagWithSchema } from "../../utils";

const componentConfigurationSchema = z
  .object({
    configuration: z.unknown().refine((value) => value !== undefined, "configuration is required"),
  })
  .strict();

const componentMapSchema = z
  .record(z.string().min(1), componentConfigurationSchema)
  .refine((components) => Object.keys(components).length > 0, {
    message: "must contain at least one component",
  });

export type ConfigurationBundleComponents = Record<string, ComponentConfiguration>;

export async function resolveConfigurationBundleComponents(
  value: string,
  source: SourceResolver,
): Promise<ConfigurationBundleComponents> {
  const text = await source.resolveText("components", value);
  const components = parseJsonFlagWithSchema("components", text, componentMapSchema);
  if (components === undefined) {
    throw new InputValidationError("required option '--components <components>' not specified");
  }
  return components as ConfigurationBundleComponents;
}
