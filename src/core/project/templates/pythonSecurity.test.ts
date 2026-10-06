import { expect, test } from "bun:test";
import { FsAssetSource } from "../source";
import { HandlebarsTemplateRenderer } from "./renderer";

const source = new FsAssetSource();
const renderer = new HandlebarsTemplateRenderer();

test.each([
  ["agent-python-minimal", ["bedrock-agentcore >= 1.18.1, < 2.0.0"]],
  ["agent-python-strands", ["bedrock-agentcore[strands-agents] >= 1.18.1, < 2.0.0"]],
  [
    "a2a-python-strands",
    [
      "a2a-sdk[all] ~= 0.3.26",
      "aws-opentelemetry-distro ~= 0.21.0",
      "bedrock-agentcore[a2a,strands-agents] ~= 1.24.0",
      "botocore[crt] ~= 1.43.107",
      "strands-agents ~= 1.57.2",
    ],
  ],
  ["agui-python-strands", ["bedrock-agentcore[strands-agents] >= 1.18.1, < 2.0.0"]],
  [
    "export-harness-python",
    ["bedrock-agentcore[strands-agents] >= 1.18.1, < 2.0.0", "mcp >= 1.28.1, < 2.0.0"],
  ],
  ["mcp-python-fastmcp", ["mcp >= 1.28.1, < 2.0.0"]],
] as const)("%s retains patched Python dependency ranges", async (template, dependencies) => {
  const pyproject = renderer.render(await source.read(`templates/${template}/pyproject.toml`), {
    name: "test_agent",
    modelProvider: "Bedrock",
  });

  expect(Bun.TOML.parse(pyproject)).toMatchObject({
    project: { dependencies: expect.arrayContaining([...dependencies]) },
  });
});

test("the Strands container updates OS packages and removes uv after installing dependencies", async () => {
  const dockerfile = renderer.render(
    await source.read("templates/agent-python-strands/Dockerfile.template"),
    { entrypoint: "main" },
  );

  expect(dockerfile).toMatch(
    /RUN apt-get update && apt-get upgrade -y[\s\S]*USER bedrock_agentcore/,
  );
  expect(dockerfile).toMatch(
    /UV_NO_CACHE=1[\s\S]*RUN uv sync --frozen --no-dev --no-install-project/,
  );
  expect(dockerfile).toMatch(
    /RUN uv sync --frozen --no-dev && \/usr\/local\/bin\/python -m pip uninstall -y uv[\s\S]*USER bedrock_agentcore/,
  );
});
