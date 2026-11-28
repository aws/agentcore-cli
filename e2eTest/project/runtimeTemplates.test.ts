import { describe, expect, test } from "vitest";
import { TAGS } from "../constants";
import { CliRunner, parseResult } from "../helpers/run";
import { TIMEOUT_MS } from "../timeouts";
import {
  RUNTIME_TEMPLATES,
  OperationSchema,
  RuntimeInvokeResponseSchema,
  DeployResponseSchema,
  JsonObjectSchema,
  CREATED_RUNTIME_NAME,
  LOCAL_DEV_PORT_BASE,
  assertRunsInBox,
  createTemplateProject,
  invokeLocally,
  assertProtocolResponse,
  getSessionId,
} from "./templates-test-support";

// Each template gets its own project from `agentcore create --template`, the
// command that scaffolds template code (`add runtime` only writes docs). The
// projects are independent, so the templates run concurrently; each one's
// steps run in order inside its test.
describe(
  "create, dev, deploy, invoke for runtime templates",
  { tags: [TAGS.RUNTIME, TAGS.CANARY] },
  () => {
    const cli = new CliRunner();

    test.concurrent.each(RUNTIME_TEMPLATES)(
      "$name",
      {
        timeout:
          TIMEOUT_MS.PROJECT_CREATE +
          TIMEOUT_MS.PROJECT_DEV +
          2 * TIMEOUT_MS.PROJECT_INVOKE +
          2 * TIMEOUT_MS.PROJECT_DEPLOY +
          TIMEOUT_MS.PROJECT_REMOVE,
      },
      async (runtime) => {
        const projectDir = await createTemplateProject(cli, runtime, { deploys: true });
        let scenarioCompleted = false;
        try {
          if (!runtime.skipDev) {
            await invokeLocally(
              cli,
              runtime,
              projectDir,
              LOCAL_DEV_PORT_BASE + RUNTIME_TEMPLATES.indexOf(runtime),
            );
          }

          const deployment = parseResult(
            DeployResponseSchema,
            await cli.run(["deploy", "--yes", "--json"], projectDir),
          );
          expect(deployment.message).toContain("deployed project");

          const response = parseResult(
            RuntimeInvokeResponseSchema,
            await cli.run(
              [
                "invoke",
                "--runtime",
                CREATED_RUNTIME_NAME,
                "--session-id",
                getSessionId(runtime.name),
                "--payload",
                JSON.stringify(runtime.payload),
                "--json",
                ...(runtime.invokeFlags ?? []),
              ],
              projectDir,
            ),
          );
          expect(response.complete).toBe(true);
          // As locally: an agent that failed to start answers with an error status or nothing.
          expect(response.statusCode).toBeGreaterThanOrEqual(200);
          expect(response.statusCode).toBeLessThan(300);
          expect(response.body.trim()).not.toBe("");
          if (runtime.protocol === "MCP" || runtime.protocol === "A2A") {
            assertProtocolResponse(runtime, response.body);
          }
          if (runtime.box) await assertRunsInBox(cli, projectDir);

          const removed = parseResult(
            OperationSchema,
            await cli.run(
              ["remove", "runtime", "--name", CREATED_RUNTIME_NAME, "--json"],
              projectDir,
            ),
          );
          expect(removed.operation).toBe("remove");
          scenarioCompleted = true;
        } finally {
          // Tear the stack down even when a step above failed.
          await cli.run(["remove", "all", "--yes", "--json"], projectDir);
          const cleanup = await cli.run(["deploy", "--yes", "--json"], projectDir);
          // A cleanup error must not replace the scenario's primary diagnostic.
          if (scenarioCompleted) parseResult(JsonObjectSchema, cleanup);
        }
      },
    );
  },
);
