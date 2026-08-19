import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { createDevEnvironmentLoader } from "./environment";

const projectRoot = "/workspace/project";

const runtime = (envVars: { name: string; value: string }[] = []) =>
  ({ name: "orders", build: "Container", envVars }) as ProjectRuntime;

const input = (envVars: { name: string; value: string }[] = []) => ({
  projectRoot,
  runtime: runtime(envVars),
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
        input([
          { name: "SHARED", value: "runtime" },
          { name: "RUNTIME_ONLY", value: "yes" },
          { name: "PORT", value: "1234" },
        ]),
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

    const pending = loader(input([{ name: "RUNTIME_ONLY", value: "yes" }]));
    if (expectedError) {
      await expect(pending).rejects.toThrow(expectedError);
    } else {
      await expect(pending).resolves.toEqual({
        env: { RUNTIME_ONLY: "yes", AWS_REGION: "us-east-1" },
      });
    }
  });
});
