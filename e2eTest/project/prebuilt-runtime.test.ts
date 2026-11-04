import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  CloudFormationClient,
  DescribeStacksCommand,
  GetTemplateCommand,
} from "@aws-sdk/client-cloudformation";
import z from "zod";
import { TAGS } from "../constants";
import { CliRunner, parseResult } from "../helpers/run";
import { retry } from "../helpers/retry";
import { TIMEOUT_MS } from "../timeouts";

// Supply existing ARM64 HTTP fixtures; this suite never creates or publishes images.
const v1 = process.env.AGENTCORE_PREBUILT_V1_URI;
const digest = process.env.AGENTCORE_PREBUILT_V1_DIGEST_URI;
const v2 = process.env.AGENTCORE_PREBUILT_V2_URI;
const publicUri = process.env.AGENTCORE_PREBUILT_PUBLIC_URI;
const resultSchema = z.object({ message: z.string() }).passthrough();
const operationSchema = z.object({ operation: z.string() });
const invocationSchema = z.object({
  statusCode: z.literal(200),
  body: z.string(),
  complete: z.literal(true),
});

describe("pre-built Runtime images", { tags: [TAGS.RUNTIME] }, () => {
  const cli = new CliRunner();
  const cfn = new CloudFormationClient({
    region: process.env.AWS_REGION ?? "us-west-2",
  });

  async function createProject() {
    const parent = await mkdtemp(join(tmpdir(), "agentcore-prebuilt-e2e-"));
    const name = `pbe2e${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const created = parseResult(
      z.object({ project: z.object({ path: z.string() }) }),
      await cli.run(
        ["create", "--name", name, "--template", "empty", "--skip-git", "--json"],
        parent,
      ),
    );
    const path = created.project.path;
    // Before the CDK release, exercise the actual package built from PR #440.
    if (process.env.AGENTCORE_CDK_PACKAGE) {
      await promisify(execFile)(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["install", process.env.AGENTCORE_CDK_PACKAGE],
        { cwd: join(path, "agentcore", "cdk") },
      );
    }
    const stack = `AgentCore-${name}-default`;
    console.info(`pre-built Runtime test project: ${path}; stack: ${stack}`);
    return { path, stack };
  }

  async function addImage(path: string, name: string, containerUri: string) {
    parseResult(
      operationSchema,
      await cli.run(
        [
          "add",
          "runtime",
          "--name",
          name,
          "--advanced-configuration",
          JSON.stringify({ containerUri }),
          "--json",
        ],
        path,
      ),
    );
    await expect(readFile(join(path, "app", name, "main.py"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }

  async function invoke(path: string, name: string, version: string, qualifier?: string) {
    await retry(
      async () => {
        const response = parseResult(
          invocationSchema,
          await cli.run(
            [
              "invoke",
              "--runtime",
              name,
              "--session-id",
              randomUUID(),
              "--payload",
              '{"test":"prebuilt-e2e"}',
              "--json",
              ...(qualifier ? ["--qualifier", qualifier] : []),
            ],
            path,
          ),
        );
        expect(JSON.parse(response.body)).toEqual({
          version,
          echo: { test: "prebuilt-e2e" },
        });
      },
      TIMEOUT_MS.PROJECT_INVOKE,
      2_000,
    );
  }

  async function runtimeIds(stack: string) {
    const response = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
    return Object.fromEntries(
      (response.Stacks?.[0]?.Outputs ?? [])
        .filter((output) => output.ExportName?.endsWith("-RuntimeId"))
        .map((output) => [output.ExportName!, output.OutputValue!]),
    );
  }

  async function assertNoBuilder(stack: string) {
    const response = await cfn.send(new GetTemplateCommand({ StackName: stack }));
    const template = JSON.parse(response.TemplateBody!) as {
      Resources: Record<string, { Type: string }>;
    };
    const types = Object.values(template.Resources).map((resource) => resource.Type);
    expect(types).not.toContain("AWS::CodeBuild::Project");
    expect(types).not.toContain("AWS::ECR::Repository");
    expect(types.every((type) => !type.startsWith("Custom::"))).toBe(true);
  }

  async function cleanup(path: string) {
    parseResult(operationSchema, await cli.run(["remove", "all", "--yes", "--json"], path));
    parseResult(resultSchema, await cli.run(["deploy", "--yes", "--json"], path));
  }

  test.skipIf(!v1 || !digest || !v2)(
    "tag, digest, named endpoint, image update, and stack teardown",
    { timeout: 5 * TIMEOUT_MS.PROJECT_DEPLOY + 5 * TIMEOUT_MS.PROJECT_INVOKE },
    async () => {
      const { path, stack } = await createProject();
      try {
        await addImage(path, "tagged", v1!);
        await addImage(path, "digest", digest!);
        parseResult(resultSchema, await cli.run(["build", "--json"], path));
        parseResult(resultSchema, await cli.run(["deploy", "--yes", "--json"], path));
        await assertNoBuilder(stack);
        await invoke(path, "tagged", "v1");
        await invoke(path, "digest", "v1");
        const idsBefore = await runtimeIds(stack);

        parseResult(
          operationSchema,
          await cli.run(
            [
              "add",
              "runtime-endpoint",
              "--runtime",
              "tagged",
              "--name",
              "stable",
              "--version",
              "1",
              "--json",
            ],
            path,
          ),
        );
        const specPath = join(path, "agentcore", "agentcore.json");
        const spec = JSON.parse(await readFile(specPath, "utf8"));
        spec.runtimes.find((runtime: { name: string }) => runtime.name === "tagged").containerUri =
          v2;
        await writeFile(specPath, JSON.stringify(spec, null, 2));
        parseResult(resultSchema, await cli.run(["deploy", "--yes", "--json"], path));
        expect(await runtimeIds(stack)).toEqual(idsBefore);
        await assertNoBuilder(stack);
        await invoke(path, "tagged", "v2");
        await invoke(path, "digest", "v1");
        await invoke(path, "tagged", "v1", "stable");
      } finally {
        await cleanup(path);
      }
    },
  );

  test.skipIf(!publicUri)(
    "an existing public ECR image deploys and invokes without a build",
    { timeout: 2 * TIMEOUT_MS.PROJECT_DEPLOY + TIMEOUT_MS.PROJECT_INVOKE },
    async () => {
      const { path, stack } = await createProject();
      try {
        await addImage(path, "public", publicUri!);
        parseResult(resultSchema, await cli.run(["deploy", "--yes", "--json"], path));
        await assertNoBuilder(stack);
        await invoke(path, "public", "v1");
      } finally {
        await cleanup(path);
      }
    },
  );
});
