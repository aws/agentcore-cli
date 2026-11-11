import { describe, expect, test } from "bun:test";
import { InputValidationError } from "../../errors";
import { HarnessModelSchema } from "../../projectSchemas/harness";
import { toHarnessGatewayModel, toLiteLlmGatewayModel } from "./liteLlmGateway";

describe("LiteLLM gateway authoring", () => {
  test.each(["my-model", "bedrock/my-model", "openai/my-model", "litellm_proxy/my-model"])(
    "routes the gateway alias %s through the proxy provider",
    (modelId) => {
      const model = {
        modelId,
        apiBase: " https://gateway.example.com/v1 ",
        apiKeyArn: "arn:gateway-key",
        maxTokens: 123,
      };
      const result = toLiteLlmGatewayModel(model);
      expect(result).toEqual({
        modelId: modelId.startsWith("litellm_proxy/") ? modelId : `litellm_proxy/${modelId}`,
        apiBase: "https://gateway.example.com/v1",
        apiKeyArn: "arn:gateway-key",
        maxTokens: 123,
      });
      expect(model.apiBase).toBe(" https://gateway.example.com/v1 ");
    },
  );

  test.each([undefined, "", " ", "gateway.example.com", "ftp://gateway.example.com"])(
    "rejects a missing or invalid gateway URL: %j",
    (apiBase) => {
      expect(() => toLiteLlmGatewayModel({ modelId: "my-model", apiBase })).toThrow(
        InputValidationError,
      );
    },
  );

  test.each(["", " ", "litellm_proxy/"])("rejects an empty gateway alias: %j", (modelId) => {
    expect(() =>
      toLiteLlmGatewayModel({ modelId, apiBase: "https://gateway.example.com" }),
    ).toThrow(InputValidationError);
  });

  test("gateway credentials and configured fields survive", () => {
    expect(
      toHarnessGatewayModel({
        liteLlmModelConfig: {
          modelId: " my-model ",
          apiBase: "http://localhost:4000",
          apiKeyArn: "arn:gateway-key",
          additionalParams: { seed: 42 },
        },
      }),
    ).toEqual({
      liteLlmModelConfig: {
        modelId: "litellm_proxy/my-model",
        apiBase: "http://localhost:4000",
        apiKeyArn: "arn:gateway-key",
        additionalParams: { seed: 42 },
      },
    });
  });

  test.each([undefined, "", " "])("requires a gateway credential: %j", (apiKeyArn) => {
    expect(() =>
      toLiteLlmGatewayModel({
        modelId: "my-model",
        apiBase: "https://gateway.example.com",
        apiKeyArn,
      }),
    ).toThrow("enter a LiteLLM gateway API-key credential provider ARN or key file");
  });

  test("accepts a project-managed gateway credential", () => {
    expect(
      toLiteLlmGatewayModel({
        modelId: "my-model",
        apiBase: "https://gateway.example.com",
        apiKeyCredentialName: "GatewayKey",
      }),
    ).toEqual({
      modelId: "litellm_proxy/my-model",
      apiBase: "https://gateway.example.com",
      apiKeyCredentialName: "GatewayKey",
    });
  });

  test.each(["apiKeyArn", "apiKeyCredentialName"] as const)(
    "returns the parsed %s without mutating the input",
    (credentialField) => {
      const input = {
        modelId: " my-model ",
        apiBase: " https://gateway.example.com/v1 ",
        [credentialField]: " GatewayCredential ",
        maxTokens: 123,
      };
      expect(toLiteLlmGatewayModel(input)).toEqual({
        ...input,
        modelId: "litellm_proxy/my-model",
        apiBase: "https://gateway.example.com/v1",
        [credentialField]: "GatewayCredential",
      });
      expect(input[credentialField]).toBe(" GatewayCredential ");
    },
  );

  test.each([undefined, "", " "])(
    "reports both a missing URL and project credential: %j",
    (apiBase) => {
      const parse = () => toLiteLlmGatewayModel({ modelId: "my-model", apiBase });
      expect(parse).toThrow("enter the LiteLLM gateway API base URL");
      expect(parse).toThrow("enter a LiteLLM gateway API-key credential provider ARN or key file");
    },
  );

  test.each([undefined, "arn:gateway-key"])(
    "rejects project credential names in standalone API models with ARN %j",
    (apiKeyArn) => {
      const model = {
        liteLlmModelConfig: {
          modelId: "my-model",
          apiBase: "https://gateway.example.com/v1",
          apiKeyArn,
          apiKeyCredentialName: "GatewayKey",
        },
      };
      expect(() => toHarnessGatewayModel(model)).toThrow(
        "apiKeyCredentialName is only supported in projects; use apiKeyArn for the Harness API",
      );
    },
  );

  test.each([
    "model",
    "api_base",
    "base_url",
    "custom_llm_provider",
    "use_litellm_proxy",
    "fallbacks",
  ])("rejects the routing override %s in additionalParams", (key) => {
    expect(() =>
      toLiteLlmGatewayModel({
        modelId: "my-model",
        apiBase: "https://gateway.example.com/v1",
        apiKeyArn: "arn:gateway-key",
        additionalParams: { [key]: "override" },
      }),
    ).toThrow(`cannot override routing: ${key}`);
  });

  test("does not change other providers or the service default", () => {
    const bedrock = { bedrockModelConfig: { modelId: "bedrock-model" } };
    expect(toHarnessGatewayModel(bedrock)).toBe(bedrock);
    expect(toHarnessGatewayModel(undefined)).toBeUndefined();
  });

  test("leaves the existing project/service schema compatible with direct SDK models", () => {
    expect(
      HarnessModelSchema.parse({ provider: "lite_llm", modelId: "bedrock/existing-model" }),
    ).toEqual({ provider: "lite_llm", modelId: "bedrock/existing-model" });
  });
});
