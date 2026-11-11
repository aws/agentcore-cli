import { expect, test } from "bun:test";
import { resolveScaffoldHarnessInput } from "./index";
import { InputValidationError } from "../../../errors";

test.each([
  ["at the 15-character threshold", "P".repeat(15), /^P{15}$/],
  ["one over the threshold", "P".repeat(16), /^P{9}_[0-9a-f]{5}$/],
  ["at the 23-character project name maximum", "P".repeat(23), /^P{2}_[0-9a-f]{5}$/],
])("the default harness name for a project %s", (_label, projectName, pattern) => {
  expect(resolveScaffoldHarnessInput({ name: projectName }).name).toMatch(pattern);
});

test("scaffolding LiteLLM requires a model alias and gateway URL", () => {
  const input = { name: "GatewayApp", "model-provider": "lite_llm" as const };
  expect(() => resolveScaffoldHarnessInput(input)).toThrow(InputValidationError);
  expect(() => resolveScaffoldHarnessInput({ ...input, "model-id": "my-model" })).toThrow(
    "enter the LiteLLM gateway API base URL",
  );
  expect(
    resolveScaffoldHarnessInput({
      ...input,
      "model-id": "my-model",
      "api-base": "https://gateway.example.com/v1",
      "api-key-arn": "arn:gateway-key",
    }).model,
  ).toMatchObject({
    provider: "lite_llm",
    modelId: "litellm_proxy/my-model",
    apiBase: "https://gateway.example.com/v1",
  });
});
