import { describe, test, expect } from "bun:test";
import {
  AccessDeniedException,
  ValidationException,
  InternalServerException,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { classify } from "./classify";
import { type ErrorSource } from "./types";
import { AgentCoreCLIError, InputValidationError } from "./errors";

describe("classify", () => {
  test("preserves existing AgentCoreCLIError instances", () => {
    const err = new AgentCoreCLIError("cli error", { source: "internal" });
    expect(classify(err)).toBe(err);
  });

  test("preserves AgentCoreCLIError subclasses", () => {
    const err = new InputValidationError("bad input");
    expect(classify(err)).toBe(err);
  });

  test.each<[Error, ErrorSource]>([
    [new AccessDeniedException({ $metadata: { httpStatusCode: 403 }, message: "" }), "user"],
    [
      new ValidationException({
        $metadata: { httpStatusCode: 400 },
        message: "",
        reason: "FieldValidationFailed",
      }),
      "user",
    ],
    [new InternalServerException({ $metadata: { httpStatusCode: 500 }, message: "" }), "service"],
    [new InternalServerException({ $metadata: {}, message: "" }), "service"],
  ])("SDK %s → %s source", (err, expectedSource) => {
    const result = classify(err);
    expect(result).toBeInstanceOf(AgentCoreCLIError);
    expect(result.source).toBe(expectedSource);
  });

  test.each([
    [new Error("plain error"), "plain error"],
    ["string error", "string error"],
    [null, "null"],
    [undefined, "undefined"],
  ])("non-SDK error %j → unknown source", (input, expectedMessage) => {
    const result = classify(input);
    expect(result.source).toBe("unknown");
    expect(result.message).toBe(expectedMessage);
  });
});
