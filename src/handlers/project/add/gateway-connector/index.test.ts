import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const COMPLETE_CONNECTOR = JSON.stringify({
  name: "configured",
  targetType: "connector",
  connectorId: "web-search",
});

const { addGateway, cleanup, inProject, projectSpec, run } =
  createGatewayProjectTestHarness("gateway-connector");

afterEach(cleanup);

describe("project add gateway-connector", () => {
  test("--json preserves the command resource type and parent Gateway", async () => {
    const projectRoot = await inProject();
    await addGateway();

    const io = await run([
      "add",
      "gateway-connector",
      "--gateway",
      "tools",
      "--name",
      "web",
      "--connector",
      "web-search",
      "--json",
    ]);

    expect(JSON.parse(io.stdout())).toEqual({
      operation: "add",
      project: { name: "TestProject", path: projectRoot },
      resource: {
        type: "gateway-connector",
        name: "web",
        parent: { type: "gateway", name: "tools" },
      },
    });
    expect(io.stderr()).not.toContain("added Connector Target");
  });

  test("adds Web Search and external Knowledge Base connectors", async () => {
    const projectRoot = await inProject();
    await addGateway();

    await run([
      "add",
      "gateway-connector",
      "--gateway",
      "tools",
      "--name",
      "web",
      "--connector",
      "web-search",
    ]);
    await run([
      "add",
      "gateway-connector",
      "--gateway",
      "tools",
      "--name",
      "knowledge",
      "--connector",
      "bedrock-knowledge-bases",
      "--knowledge-base",
      "ABCDEFGHIJ",
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets).toEqual([
      {
        name: "web",
        targetType: "connector",
        connectorId: "web-search",
        configurations: [{ name: "WebSearch", parameterValues: { maxResults: 10 } }],
      },
      {
        name: "knowledge",
        targetType: "connector",
        connectorId: "bedrock-knowledge-bases",
        configurations: [{ name: "Retrieve", parameterValues: { knowledgeBaseId: "ABCDEFGHIJ" } }],
      },
    ]);
  });

  test("reads a complete connector Target from a file", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const target = {
      name: "configured",
      targetType: "connector",
      connectorId: "web-search",
      configurations: [{ name: "WebSearch", parameterValues: { maxResults: 3 } }],
    };
    const path = join(projectRoot, "connector.json");
    await writeFile(path, JSON.stringify(target));

    await run([
      "add",
      "gateway-connector",
      "--gateway",
      "tools",
      "--connector-configuration",
      `file://${path}`,
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0]).toEqual(target);
  });

  test("rejects a non-connector project Target", async () => {
    await inProject();
    await addGateway();

    await expect(
      run([
        "add",
        "gateway-connector",
        "--gateway",
        "tools",
        "--connector-configuration",
        '{"name":"server","targetType":"mcpServer","endpoint":"https://mcp.example.com"}',
      ]),
    ).rejects.toThrow('targetType: "connector"');
  });

  test.each([
    [
      "missing parent Gateway",
      ["--name", "web", "--connector", "web-search"],
      "required option '--gateway",
    ],
    ["no connector mode", ["--gateway", "tools", "--name", "web"], "specify exactly one"],
    [
      "both connector modes",
      [
        "--gateway",
        "tools",
        "--name",
        "web",
        "--connector",
        "web-search",
        "--connector-configuration",
        COMPLETE_CONNECTOR,
      ],
      "specify exactly one",
    ],
    [
      "name with complete connector JSON",
      ["--gateway", "tools", "--name", "web", "--connector-configuration", COMPLETE_CONNECTOR],
      "--name is part of --connector-configuration",
    ],
    [
      "knowledge base with complete connector JSON",
      [
        "--gateway",
        "tools",
        "--connector-configuration",
        COMPLETE_CONNECTOR,
        "--knowledge-base",
        "ABCDEFGHIJ",
      ],
      "--knowledge-base cannot be combined",
    ],
    [
      "shortcut without name",
      ["--gateway", "tools", "--connector", "web-search"],
      "required option '--name",
    ],
    [
      "knowledge base with Web Search",
      [
        "--gateway",
        "tools",
        "--name",
        "web",
        "--connector",
        "web-search",
        "--knowledge-base",
        "ABCDEFGHIJ",
      ],
      "--knowledge-base requires --connector bedrock-knowledge-bases",
    ],
    [
      "Knowledge Base connector without Knowledge Base",
      ["--gateway", "tools", "--name", "knowledge", "--connector", "bedrock-knowledge-bases"],
      "requires --knowledge-base",
    ],
  ])("rejects %s", async (_label, flags, message) => {
    await inProject();
    await addGateway();
    await expect(run(["add", "gateway-connector", ...flags])).rejects.toThrow(message);
  });
});
