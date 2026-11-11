import z from "zod";
import type { HarnessModelConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../errors";

const PROXY_PREFIX = "litellm_proxy/";
const ROUTING_PARAMS = [
  "model",
  "api_base",
  "base_url",
  "custom_llm_provider",
  "use_litellm_proxy",
  "fallbacks",
] as const;

export const liteLlmGatewayModelIdSchema = z
  .string({ error: "enter the model alias configured in your LiteLLM gateway" })
  .trim()
  .refine(
    (value) => value !== "" && value !== PROXY_PREFIX,
    "enter the model alias configured in your LiteLLM gateway",
  );

export const liteLlmGatewayUrlSchema = z
  .string({ error: "enter the LiteLLM gateway API base URL" })
  .trim()
  .min(1, "enter the LiteLLM gateway API base URL")
  .url("enter the LiteLLM gateway as an http(s) URL")
  .regex(/^https?:\/\//, "enter the LiteLLM gateway as an http(s) URL");

const gatewayModelSchema = z.object({
  modelId: liteLlmGatewayModelIdSchema.prefault(""),
  apiBase: liteLlmGatewayUrlSchema.prefault(""),
  apiKeyArn: z.string().trim().optional(),
  apiKeyCredentialName: z.string().trim().optional(),
});

const projectGatewayModelSchema = gatewayModelSchema.superRefine((model, ctx) => {
  if (!model.apiKeyArn && !model.apiKeyCredentialName) {
    ctx.addIssue({
      code: "custom",
      path: ["apiKeyArn"],
      message: "enter a LiteLLM gateway API-key credential provider ARN or key file",
    });
  }
});

const standaloneGatewayModelSchema = gatewayModelSchema.superRefine((model, ctx) => {
  if (model.apiKeyCredentialName !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["apiKeyCredentialName"],
      message:
        "apiKeyCredentialName is only supported in projects; use apiKeyArn for the Harness API",
    });
  }
  if (!model.apiKeyArn) {
    ctx.addIssue({
      code: "custom",
      path: ["apiKeyArn"],
      message: "enter a LiteLLM gateway API-key credential provider ARN",
    });
  }
});

type GatewayModelInput = {
  modelId?: string;
  apiBase?: string;
  apiKeyArn?: string;
  apiKeyCredentialName?: string;
  additionalParams?: unknown;
};

type ParsedGatewayModel<T> = Omit<T, "modelId" | "apiBase" | "apiKeyArn" | "apiKeyCredentialName"> &
  z.infer<typeof gatewayModelSchema>;

export function liteLlmGatewayModelId(modelId: string): string {
  const alias = modelId.trim();
  if (alias === "") return "";
  return alias.startsWith(PROXY_PREFIX) ? alias : `${PROXY_PREFIX}${alias}`;
}

function parseGatewayModel<T extends GatewayModelInput>(
  model: T,
  schema: typeof gatewayModelSchema,
): ParsedGatewayModel<T> {
  const result = schema.safeParse(model);
  if (!result.success) {
    throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });
  }
  // Strands merges additionalParams over the request, including its model route.
  const params = model.additionalParams;
  if (typeof params === "object" && params !== null) {
    const overrides = ROUTING_PARAMS.filter((key) => Object.hasOwn(params, key));
    if (overrides.length > 0) {
      throw new InputValidationError(
        `LiteLLM gateway additionalParams cannot override routing: ${overrides.join(", ")}. ` +
          "Configure routing and fallbacks on the gateway instead.",
      );
    }
  }
  return {
    ...model,
    ...result.data,
    modelId: liteLlmGatewayModelId(result.data.modelId),
  };
}

export function toLiteLlmGatewayModel<T extends GatewayModelInput>(
  model: T,
): ParsedGatewayModel<T> {
  return parseGatewayModel(model, projectGatewayModelSchema);
}

export function toHarnessGatewayModel(
  model: HarnessModelConfiguration | undefined,
): HarnessModelConfiguration | undefined {
  if (!model?.liteLlmModelConfig) return model;
  return {
    ...model,
    liteLlmModelConfig: parseGatewayModel(model.liteLlmModelConfig, standaloneGatewayModelSchema),
  };
}
