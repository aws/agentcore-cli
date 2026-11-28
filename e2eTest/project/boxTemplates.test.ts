import { describe, expect, test } from "vitest";
import { TAGS } from "../constants";
import { CliRunner, parseResult } from "../helpers/run";
import { TIMEOUT_MS } from "../timeouts";
import {
  BOX_ON_PATH,
  BOX_DEPLOYS,
  BOX_TEMPLATES,
  RuntimeInvokeResponseSchema,
  DeployResponseSchema,
  JsonObjectSchema,
  CREATED_RUNTIME_NAME,
  DEPLOY_TEMPLATES,
  fullFlow,
  DEV_ONLY_TEMPLATES,
  assertStrandsBoxAssets,
  assertRunsInBox,
  tearDown,
  createTemplateProject,
  devInBox,
  assertProtocolResponse,
  getSessionId,
} from "./templates-test-support";

// The Strands Box templates run their agent in a box, locally and on AgentCore Runtime. Each test
// takes one project through build, deploy, invoke, and checks that the Runtime started the agent
// in a box. The FULL_FLOW_TEMPLATES also run dev and invoke --local before build and again after
// deploy, in the same project, as a user does: dev leaves state that build and deploy then read
// (box binds each profile name to the file that ran it), and build and deploy leave state that dev
// must still run beside. Their dev steps wait for the other tests on their box ingress port
// (withDevPort); every deploy runs concurrently. The container template skips dev without a
// container tool. They need `box` on PATH and the AGENTCORE_E2E_BOX_CDK opt-in, a Box-capable
// @aws/agentcore-cdk build. Run them with `bun run test:e2e -- --tagsFilter='box'`.
describe.skipIf(!BOX_DEPLOYS)(
  "build, deploy, invoke for Strands Box templates, with dev before and after for some",
  { tags: [TAGS.RUNTIME, TAGS.BOX] },
  () => {
    const cli = new CliRunner();
    const cases = DEPLOY_TEMPLATES.map((runtime) => ({
      ...runtime,
      flow: fullFlow(runtime) ? "dev, build, deploy, dev" : "build, deploy",
    }));

    test.concurrent.each(cases)(
      "$name: $flow",
      {
        // A dev step may wait for every other dev step on its port.
        timeout:
          TIMEOUT_MS.PROJECT_CREATE +
          2 * BOX_TEMPLATES.length * (TIMEOUT_MS.PROJECT_DEV + TIMEOUT_MS.PROJECT_INVOKE) +
          2 * TIMEOUT_MS.PROJECT_INVOKE +
          3 * TIMEOUT_MS.PROJECT_DEPLOY +
          TIMEOUT_MS.PROJECT_REMOVE,
      },
      async (runtime) => {
        const projectDir = await createTemplateProject(cli, runtime, { deploys: true });
        const withDev = fullFlow(runtime);
        let scenarioCompleted = false;
        try {
          if (withDev) await devInBox(cli, runtime, projectDir);

          // Build after dev, as a user does: build runs box on the local profile that dev ran.
          parseResult(JsonObjectSchema, await cli.run(["build", "--json"], projectDir));
          await assertStrandsBoxAssets(projectDir);

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
          // An agent that box started but that failed answers with an error status or nothing.
          expect(response.statusCode).toBeGreaterThanOrEqual(200);
          expect(response.statusCode).toBeLessThan(300);
          expect(response.body.trim()).not.toBe("");
          if (runtime.protocol === "MCP" || runtime.protocol === "A2A") {
            assertProtocolResponse(runtime, response.body);
          }

          await assertRunsInBox(cli, projectDir);

          // Dev again after build and deploy: they leave state (box's profile bindings, the
          // Runtime profile, .box-dist) that dev must still run beside.
          if (withDev) await devInBox(cli, runtime, projectDir);
          scenarioCompleted = true;
        } finally {
          // Tear the stack down even when a step above failed.
          await tearDown(cli, projectDir, scenarioCompleted);
        }
      },
    );
  },
);

describe.skipIf(!BOX_ON_PATH || DEV_ONLY_TEMPLATES.length === 0)(
  "create and dev for Strands Box templates",
  { tags: [TAGS.BOX], sequential: true },
  () => {
    const cli = new CliRunner();
    const templates = DEV_ONLY_TEMPLATES;

    test.each(templates)(
      "$name",
      { timeout: TIMEOUT_MS.PROJECT_CREATE + TIMEOUT_MS.PROJECT_DEV + TIMEOUT_MS.PROJECT_INVOKE },
      async (runtime) => {
        const projectDir = await createTemplateProject(cli, runtime, { deploys: false });
        await devInBox(cli, runtime, projectDir);
      },
    );
  },
);
