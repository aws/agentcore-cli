import { describe, test, expect } from "bun:test";
import {
  AccessDeniedException,
  ValidationException,
  InternalServerException,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { AgentCoreCLIError, InputValidationError } from "./errors";

describe("AgentCoreCLIError", () => {
  test("fromError preserves existing AgentCoreCLIError instances", () => {
    const err = new AgentCoreCLIError("cli error", { source: "internal" });
    expect(AgentCoreCLIError.fromError(err)).toBe(err);
  });

  test("fromError preserves AgentCoreCLIError subclasses", () => {
    const err = new InputValidationError("bad input");
    expect(AgentCoreCLIError.fromError(err)).toBe(err);
  });

  test.each([
    [
      "AccessDeniedException (403)",
      new AccessDeniedException({ $metadata: { httpStatusCode: 403 }, message: "" }),
      "user",
    ],
    [
      "ValidationException (400)",
      new ValidationException({
        $metadata: { httpStatusCode: 400 },
        message: "",
        reason: "FieldValidationFailed",
      }),
      "user",
    ],
    [
      "InternalServerException (500)",
      new InternalServerException({ $metadata: { httpStatusCode: 500 }, message: "" }),
      "service",
    ],
    [
      "InternalServerException (no status)",
      new InternalServerException({ $metadata: {}, message: "" }),
      "service",
    ],
  ])("fromError SDK %s → expected source", (_label, err, expectedSource) => {
    const result = AgentCoreCLIError.fromError(err as Error);
    expect(result.json()).toMatchObject({
      name: "AgentCoreCLIError",
      source: expectedSource,
    });
  });

  test.each([
    ["Error", new Error("plain error"), "plain error"],
    ["string", "string error", "string error"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
  ])("fromError non-SDK %s → internal source", (_label, input, expectedMessage) => {
    const result = AgentCoreCLIError.fromError(input);
    expect(result.json()).toMatchObject({
      name: "AgentCoreCLIError",
      source: "internal",
      message: expectedMessage,
    });
  });
});
