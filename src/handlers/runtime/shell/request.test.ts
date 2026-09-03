import { describe, expect, test } from "bun:test";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { PassThrough } from "node:stream";
import { rm } from "node:fs/promises";
import {
  normalizeRuntimeShellRequest,
  resolveRuntimeShellBearerToken,
  validateRuntimeShellIds,
} from "./request";

const RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/checkout-AbCdEf1234";

function runtime(overrides: Partial<GetAgentRuntimeResponse> = {}): GetAgentRuntimeResponse {
  return {
    agentRuntimeArn: RUNTIME_ARN,
    agentRuntimeId: "checkout-AbCdEf1234",
    agentRuntimeName: "checkout",
    agentRuntimeVersion: "1",
    createdAt: new Date("2026-09-03T00:00:00Z"),
    lastUpdatedAt: new Date("2026-09-03T00:00:00Z"),
    status: "READY",
    roleArn: "arn:aws:iam::123456789012:role/runtime",
    networkConfiguration: { networkMode: "PUBLIC" },
    lifecycleConfiguration: {
      idleRuntimeSessionTimeout: 900,
      maxLifetime: 28_800,
    },
    ...overrides,
  };
}

describe("normalizeRuntimeShellRequest", () => {
  test("builds an IAM shell request from Runtime detail", () => {
    expect(
      normalizeRuntimeShellRequest(runtime(), {
        qualifier: "prod",
        runtimeSessionId: "session-012345678901234567890123456789",
        shellId: "shell-1",
      }),
    ).toEqual({
      runtimeArn: RUNTIME_ARN,
      qualifier: "prod",
      runtimeSessionId: "session-012345678901234567890123456789",
      shellId: "shell-1",
    });
  });

  test("requires a bearer token for CUSTOM_JWT", () => {
    expect(() =>
      normalizeRuntimeShellRequest(
        runtime({
          authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: "https://idp" } },
        }),
        { qualifier: "DEFAULT" },
      ),
    ).toThrow("CUSTOM_JWT Runtime requires --bearer-token");
  });

  test("passes a bearer token for CUSTOM_JWT", () => {
    expect(
      normalizeRuntimeShellRequest(
        runtime({
          authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: "https://idp" } },
        }),
        { qualifier: "DEFAULT", bearerToken: "token" },
      ),
    ).toMatchObject({ bearerToken: "token" });
  });

  test("rejects a bearer token for IAM", () => {
    expect(() =>
      normalizeRuntimeShellRequest(runtime(), {
        qualifier: "DEFAULT",
        bearerToken: "token",
      }),
    ).toThrow("IAM Runtime does not accept --bearer-token");
  });

  test("rejects a Runtime that is not READY", () => {
    expect(() =>
      normalizeRuntimeShellRequest(runtime({ status: "UPDATING" }), { qualifier: "DEFAULT" }),
    ).toThrow("Runtime is not ready");
  });

  test("rejects a missing or malformed Runtime ARN", () => {
    expect(() =>
      normalizeRuntimeShellRequest(runtime({ agentRuntimeArn: "not-an-arn" }), {
        qualifier: "DEFAULT",
      }),
    ).toThrow("Runtime returned an invalid ARN");
  });
});

describe("validateRuntimeShellIds", () => {
  test("requires session ID when shell ID is supplied", () => {
    expect(() => validateRuntimeShellIds(undefined, "shell-1")).toThrow(
      "--shell-id requires --session-id",
    );
  });

  test("accepts both IDs or neither", () => {
    expect(() => validateRuntimeShellIds(undefined, undefined)).not.toThrow();
    expect(() =>
      validateRuntimeShellIds("session-012345678901234567890123456789", "shell-1"),
    ).not.toThrow();
  });
});

describe("resolveRuntimeShellBearerToken", () => {
  test("reads file:// tokens and strips one trailing newline", async () => {
    const path = `${import.meta.dir}/token.test.txt`;
    await Bun.write(path, "secret-token\n");
    try {
      await expect(
        resolveRuntimeShellBearerToken(
          `file://${path}`,
          new PassThrough() as unknown as NodeJS.ReadStream,
        ),
      ).resolves.toBe("secret-token");
    } finally {
      await rm(path, { force: true });
    }
  });

  test("accepts an inline token", async () => {
    await expect(
      resolveRuntimeShellBearerToken(
        "inline-token",
        new PassThrough() as unknown as NodeJS.ReadStream,
      ),
    ).resolves.toBe("inline-token");
  });

  test("rejects stdin because the PTY owns it", async () => {
    await expect(
      resolveRuntimeShellBearerToken("-", new PassThrough() as unknown as NodeJS.ReadStream),
    ).rejects.toThrow("stdin bearer tokens are not available");
  });
});
