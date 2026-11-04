import { expect, spyOn, test } from "bun:test";
import { InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { createBearerHarnessClient } from "./harnessBearer";

const command = () =>
  new InvokeHarnessCommand({
    harnessArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/MyHarness-abc123",
    runtimeSessionId: "s".repeat(40),
    messages: [{ role: "user", content: [{ text: "hi" }] }],
  });

test("Harness bearer client sends a JWT without SigV4", async () => {
  let authorization: string | undefined;
  let sigv4Date: string | undefined;
  const client = createBearerHarnessClient(
    {
      region: "us-west-2",
      endpointUrl: "https://example.test",
      credentials: async () => {
        throw new Error("Bearer invocation must not resolve AWS credentials");
      },
    },
    "secret-token",
  );
  const handle = spyOn(client.config.requestHandler, "handle").mockImplementation(
    async (request) => {
      const headers = (request as { headers: Record<string, string> }).headers;
      authorization = headers.Authorization;
      sigv4Date = headers["x-amz-date"];
      return {
        response: {
          statusCode: 403,
          headers: { "content-type": "application/json" },
          body: Buffer.from('{"message":"expected test rejection"}'),
        },
      } as never;
    },
  );
  try {
    await expect(client.send(command())).rejects.toThrow();
    expect(authorization).toBe("Bearer secret-token");
    expect(sigv4Date).toBeUndefined();
  } finally {
    handle.mockRestore();
    client.destroy();
  }
});

test("Harness bearer client never sends a token to a resolved HTTP endpoint", async () => {
  const client = createBearerHarnessClient({ region: "us-west-2" }, "secret-token");
  client.config.endpointProvider = () => ({ url: new URL("http://example.test") });
  let sent = false;
  const handle = spyOn(client.config.requestHandler, "handle").mockImplementation(async () => {
    sent = true;
    throw new Error("Bearer token reached the transport");
  });
  try {
    await expect(client.send(command())).rejects.toThrow("CUSTOM_JWT requires an HTTPS endpoint");
    expect(sent).toBe(false);
  } finally {
    handle.mockRestore();
    client.destroy();
  }
});
