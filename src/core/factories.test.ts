import { describe, expect, test } from "bun:test";
import { InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { createDataClient } from "./factories";
import type { DataClientConfig } from "./types";

const HARNESS_ARN = "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/MyHarness-abc123";

// signedHeaders sends an InvokeHarness through a real data client and returns the
// headers of the request as it would leave for the wire, after signing.
async function signedHeaders(config: DataClientConfig): Promise<Record<string, string>> {
  const client = createDataClient(config);
  let headers: Record<string, string> | undefined;
  client.middlewareStack.add(
    () => async (args) => {
      headers = (args.request as { headers: Record<string, string> }).headers;
      throw new Error("request captured");
    },
    { step: "deserialize", priority: "low" },
  );
  await expect(
    client.send(
      new InvokeHarnessCommand({
        harnessArn: HARNESS_ARN,
        runtimeSessionId: "s".repeat(33),
        messages: [{ role: "user", content: [{ text: "hi" }] }],
      }),
    ),
  ).rejects.toThrow("request captured");
  return headers!;
}

describe("createDataClient", () => {
  test("a bearer token authenticates with Authorization: Bearer and never resolves AWS credentials", async () => {
    const headers = await signedHeaders({
      region: "us-east-1",
      bearerToken: "jwt-123",
      credentials: () => {
        throw new Error("AWS credentials must not be resolved");
      },
    });

    expect(headers["Authorization"] ?? headers["authorization"]).toBe("Bearer jwt-123");
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("x-amz-date");
  });

  test("without a bearer token the request is SigV4-signed", async () => {
    const headers = await signedHeaders({
      region: "us-east-1",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    });

    expect(headers["authorization"]).toStartWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/");
  });
});
