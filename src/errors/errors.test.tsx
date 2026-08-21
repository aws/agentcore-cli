import { describe, test, expect } from "bun:test";
import {
  AccessDeniedException,
  ValidationException,
  InternalServerException,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { CommanderError } from "commander";
import {
  AgentCoreCLIError,
  InputValidationError,
  SilentCLIError,
  UserCancellationError,
} from "./errors";

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
    ["parse failures", new CommanderError(1, "commander.invalidArgument", "invalid option"), 2],
    ["help", new CommanderError(0, "commander.helpDisplayed", "help displayed"), 0],
  ])("fromError classifies Commander %s", (_label, err, exitCode) => {
    const result = AgentCoreCLIError.fromError(err);
    expect(result).toBeInstanceOf(SilentCLIError);
    expect(result.json()).toMatchObject({
      name: "CommanderError",
      source: "user",
      exitCode,
      meta: { code: err.code },
    });
  });

  test("UserCancellationError is a silent user interruption", () => {
    const error = new UserCancellationError();
    expect(error).toBeInstanceOf(SilentCLIError);
    expect(error.json()).toMatchObject({
      name: "UserCancellationError",
      message: "Operation cancelled by user",
      source: "user",
      exitCode: 130,
    });
  });

  test("UserCancellationError resolves direct and signal-propagated cancellation", () => {
    const cancellation = new UserCancellationError();
    const controller = new AbortController();
    controller.abort(cancellation);

    expect(UserCancellationError.resolve(cancellation)).toBe(cancellation);
    expect(UserCancellationError.resolve(new Error("transport aborted"), controller.signal)).toBe(
      cancellation,
    );
    expect(UserCancellationError.resolve(new Error("failed"))).toBeUndefined();
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
      name: err.name,
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
