import { describe, expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TAGS } from "../constants";
import { CliRunner, parseResult } from "../helpers/run";
import { retry } from "../helpers/retry";
import { TIMEOUT_MS } from "../timeouts";
import {
  BOX_ON_PATH,
  BOX_DEPLOYS,
  BOX_TEMPLATES,
  OperationSchema,
  RuntimeInvokeResponseSchema,
  DeployResponseSchema,
  CREATED_RUNTIME_NAME,
  BOX_DEV_PORTS,
  ECHO_URL,
  ECHO_AGENT,
  MCP_SERVER_URL,
  GATEWAY_AGENT,
  useEgressAgent,
  assertEgressReply,
  assertRunsInBox,
  deployed,
  ask,
  askAgent,
  DEPLOY_TEST_TIMEOUT,
  tearDown,
  createTemplateProject,
  invokeLocally,
  getSessionId,
  withDevPort,
} from "./templates-test-support";

describe.skipIf(!BOX_ON_PATH)(
  "egress under dev for a Strands Box template",
  { tags: [TAGS.BOX_EGRESS] },
  () => {
    const cli = new CliRunner();
    const runtime = BOX_TEMPLATES.find((t) => t.template === "agent-python-minimal-box");
    if (!runtime) throw new Error("BOX_TEMPLATES has no agent-python-minimal-box case");

    test(
      "allows the profile's host and blocks any other",
      {
        retry: 2,
        timeout: TIMEOUT_MS.PROJECT_CREATE + TIMEOUT_MS.PROJECT_DEV + TIMEOUT_MS.PROJECT_INVOKE,
      },
      async () => {
        const template = runtime;
        const projectDir = await createTemplateProject(cli, template, { deploys: false });
        await useEgressAgent(projectDir);

        const port = BOX_DEV_PORTS[template.protocol];
        const { response } = await withDevPort(port, () =>
          invokeLocally(cli, template, projectDir, port),
        );
        assertEgressReply(response.body);
      },
    );
  },
);

// The same egress check on AgentCore Runtime, where box sends the allowed host's calls through the
// runtime's Box gateway, and the scenarios that need a public host. Each deploys its own project, so
// they run concurrently. They need the AGENTCORE_E2E_BOX_CDK opt-in as well.
describe.skipIf(!BOX_DEPLOYS)(
  "egress on AgentCore Runtime for a Strands Box template",
  { tags: [TAGS.BOX_EGRESS] },
  () => {
    const cli = new CliRunner();
    const runtime = BOX_TEMPLATES.find((t) => t.template === "agent-python-minimal-box");
    if (!runtime) throw new Error("BOX_TEMPLATES has no agent-python-minimal-box case");

    // The public hosts can fail a call, so only the invoke retries: a retry of the whole test would
    // deploy and remove the stack again.
    test.concurrent(
      "allows the profile's host through the Box gateway and blocks any other",
      {
        timeout:
          TIMEOUT_MS.PROJECT_CREATE +
          3 * TIMEOUT_MS.PROJECT_INVOKE +
          2 * TIMEOUT_MS.PROJECT_DEPLOY +
          TIMEOUT_MS.PROJECT_REMOVE,
      },
      async () => {
        const projectDir = await createTemplateProject(cli, runtime, { deploys: true });
        await useEgressAgent(projectDir);
        let scenarioCompleted = false;
        try {
          const deployment = parseResult(
            DeployResponseSchema,
            await cli.run(["deploy", "--yes", "--json"], projectDir),
          );
          expect(deployment.message).toContain("deployed project");

          await retry(
            async () => {
              const response = parseResult(
                RuntimeInvokeResponseSchema,
                await cli.run(
                  [
                    "invoke",
                    "--runtime",
                    CREATED_RUNTIME_NAME,
                    "--session-id",
                    getSessionId(`${runtime.name}-egress`),
                    "--payload",
                    JSON.stringify(runtime.payload),
                    "--json",
                  ],
                  projectDir,
                ),
              );
              expect(response.statusCode).toBeGreaterThanOrEqual(200);
              expect(response.statusCode).toBeLessThan(300);
              assertEgressReply(response.body);
            },
            3 * TIMEOUT_MS.PROJECT_INVOKE,
            15 * 1000,
          );
          scenarioCompleted = true;
        } finally {
          // Tear the stack down even when a step above failed.
          await tearDown(cli, projectDir, scenarioCompleted);
        }
      },
    );

    // The profile's egress entry names an env:// key: build stops until deploy has stored it,
    // deploy stores it as an API key credential, and the Box gateway sends it to the host. The
    // agent never holds the key, so the echoed header can only come from the gateway.
    test.concurrent(
      "an egress route with an env:// key reaches its host with the key the Box gateway adds",
      { timeout: DEPLOY_TEST_TIMEOUT },
      async () => {
        const projectDir = await createTemplateProject(cli, runtime, { deploys: true });
        const key = `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        const env = { E2E_ECHO_KEY: key };
        await writeFile(join(projectDir, "app", CREATED_RUNTIME_NAME, "main.py"), ECHO_AGENT);
        const profile = join(projectDir, ".box", CREATED_RUNTIME_NAME, "local", "profile.toml");
        await writeFile(
          profile,
          `${await readFile(profile, "utf8")}\n[egress.echo]\ndestinations = ["${new URL(ECHO_URL).host}"]\nsecret.ref = "env://E2E_ECHO_KEY"\n`,
        );
        const build = await cli.run(["build", "--json"], projectDir, env);
        expect(build.exitCode).not.toBe(0);
        expect(`${build.stdout}${build.stderr}`).toContain("before its first deployment");
        await deployed(
          cli,
          projectDir,
          async () => {
            await retry(
              async () => {
                const body = await ask(
                  cli,
                  projectDir,
                  CREATED_RUNTIME_NAME,
                  getSessionId("box-echo"),
                  "echo",
                );
                const reply = JSON.parse(body) as {
                  status?: number;
                  authorization?: string;
                  error?: string;
                };
                expect(reply.error).toBeUndefined();
                expect(reply.status).toBe(200);
                expect(reply.authorization).toBe(`Bearer ${key}`);
              },
              3 * TIMEOUT_MS.PROJECT_INVOKE,
              15 * 1000,
            );
          },
          env,
        );
      },
    );

    // A gateway added with `add gateway` reaches a boxed runtime through its Box gateway: build
    // gives the Box gateway a target for it, and the runtime its URL. The gateway's target is a
    // public MCP server, so the agent lists that server's tools through both gateways. That server
    // is a public host, and deploy syncs the target's tools from it, so the test has the box-egress
    // tag.
    test.concurrent(
      "a gateway added with add gateway and add gateway-target lists its target's tools to the boxed agent",
      { timeout: DEPLOY_TEST_TIMEOUT },
      async () => {
        const projectDir = await createTemplateProject(cli, runtime, { deploys: true });
        for (const args of [
          ["add", "gateway", "--name", "tools", "--authorizer-type", "AWS_IAM", "--json"],
          [
            "add",
            "gateway-target",
            "--gateway",
            "tools",
            "--name",
            "docs",
            "--endpoint",
            MCP_SERVER_URL,
            "--outbound-auth",
            "none",
            "--json",
          ],
        ]) {
          expect(parseResult(OperationSchema, await cli.run(args, projectDir)).operation).toBe(
            "add",
          );
        }
        await writeFile(join(projectDir, "app", CREATED_RUNTIME_NAME, "main.py"), GATEWAY_AGENT);
        await deployed(cli, projectDir, async () => {
          await askAgent<{ tools?: string[]; error?: string }>(
            cli,
            projectDir,
            getSessionId("box-gateway"),
            "run",
            (reply) => expect(reply.tools?.some((name) => name.startsWith("docs___"))).toBe(true),
          );
          await assertRunsInBox(cli, projectDir);
        });
      },
    );
  },
);
