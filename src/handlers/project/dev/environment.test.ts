import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createDevEnvironmentLoader } from "./environment";

const projectRoot = "/workspace/project";

const input = (env: Record<string, string> = {}) => ({
  projectRoot,
  env,
  region: "us-east-1",
});

describe("createDevEnvironmentLoader", () => {
  test("merges runtime, region, and .env.local while removing runner-owned keys", async () => {
    const loader = createDevEnvironmentLoader({
      readFile: async () => `
SHARED="local value"
AWS_REGION=local-region
PORT=9999
FASTMCP_PORT=9998
LOCAL_DEV=0
MULTILINE="first
second"
`,
    });

    await expect(
      loader(
        input({
          SHARED: "runtime",
          RUNTIME_ONLY: "yes",
          PORT: "1234",
        }),
      ),
    ).resolves.toEqual({
      env: {
        SHARED: "local value",
        RUNTIME_ONLY: "yes",
        AWS_REGION: "local-region",
        MULTILINE: "first\nsecond",
      },
    });
  });

  test.each([
    ["ENOENT", undefined],
    [
      "EACCES",
      `Unable to read local environment file at ${join(projectRoot, "agentcore", ".env.local")}`,
    ],
  ] as const)("handles .env.local read error %s", async (code, expectedError) => {
    const loader = createDevEnvironmentLoader({
      readFile: async () => {
        throw Object.assign(new Error("read failed"), { code });
      },
    });

    const pending = loader(input({ RUNTIME_ONLY: "yes" }));
    if (expectedError) {
      await expect(pending).rejects.toThrow(expectedError);
    } else {
      await expect(pending).resolves.toEqual({
        env: { RUNTIME_ONLY: "yes", AWS_REGION: "us-east-1" },
      });
    }
  });
});
