import { describe, expect, test } from "bun:test";
import {
  emptyHarnessForm,
  toCreateInput,
  toUpdateRequest,
  type HarnessFormValues,
} from "./HarnessWizard";
import { toHarnessGatewayModel } from "../handlers/harness/liteLlmGateway";
import { InputValidationError } from "../errors";

function gatewayForm(): HarnessFormValues {
  return {
    ...emptyHarnessForm(),
    name: "GatewayHarness",
    model: {
      kind: "litellm",
      modelId: " my-model ",
      apiKeyArn: " arn:gateway-key ",
      apiBase: " https://gateway.example.com/v1 ",
    },
  };
}

describe("Harness wizard model conversion", () => {
  test.each(["create", "update"] as const)(
    "%s preview matches the normalized model sent at submission",
    (mode) => {
      const values = gatewayForm();
      const request =
        mode === "create"
          ? toCreateInput(values)
          : toUpdateRequest("GatewayHarness-abc123", values, emptyHarnessForm());
      expect(request.model).toEqual({
        liteLlmModelConfig: {
          modelId: "litellm_proxy/my-model",
          apiKeyArn: "arn:gateway-key",
          apiBase: "https://gateway.example.com/v1",
        },
      });
      expect(toHarnessGatewayModel(request.model)).toEqual(request.model);
      expect(values.model.apiKeyArn).toBe(" arn:gateway-key ");
    },
  );

  test("does not validate an incomplete LiteLLM form during request conversion", () => {
    const values = emptyHarnessForm();
    values.model.kind = "litellm";
    const input = toCreateInput(values);
    expect(input.model).toEqual({
      liteLlmModelConfig: { modelId: "", apiKeyArn: undefined, apiBase: undefined },
    });
    expect(() => toHarnessGatewayModel(input.model)).toThrow(InputValidationError);
  });

  test("an unrelated update does not prepare or change a legacy model", () => {
    const initial = emptyHarnessForm();
    initial.model = {
      kind: "litellm",
      modelId: "bedrock/legacy-model",
      apiKeyArn: "",
      apiBase: "",
    };
    expect(
      toUpdateRequest(
        "GatewayHarness-abc123",
        { ...initial, systemPrompt: "New instructions" },
        initial,
      ),
    ).toEqual({
      harnessId: "GatewayHarness-abc123",
      systemPrompt: [{ text: "New instructions" }],
    });
  });
});
