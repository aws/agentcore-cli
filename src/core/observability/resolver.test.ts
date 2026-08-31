import { describe, expect, test } from "bun:test";
import { DEFAULT_RUNTIME_QUALIFIER, RuntimeSourceResolver, runtimeLogGroup } from "./resolver";

describe("RuntimeSourceResolver", () => {
  const resolver = new RuntimeSourceResolver();

  test("defaults the qualifier and resolves the Runtime log group", async () => {
    const target = await resolver.resolve(
      { kind: "runtime", id: "my_agent-AbC123XyZ9" },
      { region: "us-east-1" },
    );

    expect(target).toEqual({
      resource: {
        kind: "runtime",
        id: "my_agent-AbC123XyZ9",
        qualifier: DEFAULT_RUNTIME_QUALIFIER,
      },
      logs: [
        {
          provider: "cloudwatch",
          logGroupName: "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-DEFAULT",
        },
      ],
    });
  });

  test("uses an explicitly selected endpoint qualifier", async () => {
    const target = await resolver.resolve(
      {
        kind: "runtime",
        id: "my_agent-AbC123XyZ9",
        qualifier: "production",
      },
      { region: "us-east-1" },
    );

    expect(target.resource.qualifier).toBe("production");
    expect(target.logs[0]?.logGroupName).toBe(
      "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-production",
    );
  });
});

test("runtimeLogGroup derives the service-defined location", () => {
  expect(runtimeLogGroup("runtime-1", "blue")).toBe(
    "/aws/bedrock-agentcore/runtimes/runtime-1-blue",
  );
});
