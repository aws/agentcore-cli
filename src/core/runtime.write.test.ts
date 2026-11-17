import { describe, expect, test } from "bun:test";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { ResourceNotFoundError } from "../errors";
import { createSilentLogger } from "../testing";
import { RuntimeClient } from "./runtime";
import { CREATED_BY_TAG, RUNTIME_TAG_KEY } from "./runtimeExecutionRole";
import type { AwsClients, ClientConfig } from "./types";

const REGION = "us-west-2";
const NAME = "my_agent";
const ID = `${NAME}-Ab12Cd34Ef`;
const DEFAULT_ROLE = `arn:aws:iam::111122223333:role/AgentCoreRuntime-${NAME}`;
const IMAGE = "111122223333.dkr.ecr.us-west-2.amazonaws.com/agent:v1";
const NEW_IMAGE = "111122223333.dkr.ecr.us-west-2.amazonaws.com/agent-next:v2";

const CURRENT: GetAgentRuntimeResponse = {
  agentRuntimeArn: `arn:aws:bedrock-agentcore:${REGION}:111122223333:runtime/${ID}`,
  agentRuntimeName: NAME,
  agentRuntimeId: ID,
  agentRuntimeVersion: "3",
  createdAt: new Date(0),
  lastUpdatedAt: new Date(0),
  roleArn: DEFAULT_ROLE,
  status: "READY",
  networkConfiguration: { networkMode: "PUBLIC" },
  lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
  agentRuntimeArtifact: { containerConfiguration: { containerUri: IMAGE } },
  protocolConfiguration: { serverProtocol: "MCP" },
  environmentVariables: { LOG_LEVEL: "info" },
  authorizerConfiguration: {
    customJWTAuthorizer: { discoveryUrl: "https://example.com/.well-known/openid-configuration" },
  },
  requestHeaderConfiguration: { requestHeaderAllowlist: ["X-Tenant"] },
  description: "first",
};

type Sent = { client: string; name: string; input: any; config: ClientConfig };

// fakeClients answers each SDK command by name from `answers`.
function fakeClients(answers: Record<string, (input: any, attempt: number) => unknown>) {
  const sent: Sent[] = [];
  const counts = new Map<string, number>();
  const client = (kind: string) => (config: ClientConfig) => ({
    send: async (command: { constructor: { name: string }; input: unknown }) => {
      const name = command.constructor.name;
      sent.push({ client: kind, name, input: command.input, config });
      const attempt = (counts.get(name) ?? 0) + 1;
      counts.set(name, attempt);
      const answer = answers[name];
      if (!answer) throw new Error(`unexpected ${name}`);
      return answer(command.input, attempt);
    },
  });
  const clients = { control: client("control"), iam: client("iam") } as unknown as AwsClients;
  const runtime = new RuntimeClient(clients, fetch, createSilentLogger());
  return {
    runtime,
    sent,
    input: (name: string) => sent.find((entry) => entry.name === name)?.input,
  };
}

function named(name: string, message = "error"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("RuntimeClient.createRuntime", () => {
  test("creates a PUBLIC container Runtime with the caller's role", async () => {
    const subject = fakeClients({ CreateAgentRuntimeCommand: () => ({ agentRuntimeId: ID }) });
    await subject.runtime.createRuntime(
      { runtimeName: NAME, containerUri: IMAGE, executionRoleArn: "arn:aws:iam::1:role/Mine" },
      { region: REGION },
    );
    expect(subject.sent.map((entry) => entry.client)).toEqual(["control"]);
    expect(subject.input("CreateAgentRuntimeCommand")).toMatchObject({
      agentRuntimeName: NAME,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: IMAGE } },
      roleArn: "arn:aws:iam::1:role/Mine",
      networkConfiguration: { networkMode: "PUBLIC" },
    });
  });

  test("provisions the default role, without the endpoint override, and retries while IAM propagates", async () => {
    const subject = fakeClients({
      GetRoleCommand: () => {
        throw named("NoSuchEntityException");
      },
      CreateRoleCommand: () => ({ Role: { Arn: DEFAULT_ROLE } }),
      PutRolePolicyCommand: () => ({}),
      CreateAgentRuntimeCommand: (_input, attempt) => {
        if (attempt === 1) throw named("ValidationException", "Role cannot be assumed");
        return { agentRuntimeId: ID };
      },
    });
    await subject.runtime.createRuntime(
      { runtimeName: NAME, containerUri: IMAGE },
      { region: REGION, endpointUrl: "https://control.test" },
    );
    expect(subject.sent.filter((entry) => entry.client === "iam")[0]?.config).toEqual({
      region: REGION,
    });
    const creates = subject.sent.filter((entry) => entry.name === "CreateAgentRuntimeCommand");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.input.roleArn).toBe(DEFAULT_ROLE);
  });
});

describe("RuntimeClient.updateRuntime", () => {
  test("sends the current configuration back with only the requested changes", async () => {
    const subject = fakeClients({
      GetAgentRuntimeCommand: () => CURRENT,
      UpdateAgentRuntimeCommand: () => ({ agentRuntimeVersion: "4" }),
    });
    await subject.runtime.updateRuntime(
      { runtimeId: ID, description: "second", environmentVariables: { LOG_LEVEL: "debug" } },
      { region: REGION },
    );
    expect(subject.input("UpdateAgentRuntimeCommand")).toEqual({
      agentRuntimeId: ID,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: IMAGE } },
      roleArn: DEFAULT_ROLE,
      networkConfiguration: CURRENT.networkConfiguration,
      description: "second",
      protocolConfiguration: { serverProtocol: "MCP" },
      environmentVariables: { LOG_LEVEL: "debug" },
      authorizerConfiguration: CURRENT.authorizerConfiguration,
      lifecycleConfiguration: CURRENT.lifecycleConfiguration,
      requestHeaderConfiguration: CURRENT.requestHeaderConfiguration,
      metadataConfiguration: undefined,
      filesystemConfigurations: undefined,
      capacityProviderConfiguration: undefined,
    });
    expect(subject.sent.some((entry) => entry.client === "iam")).toBe(false);
  });

  test("points the default role at a new image's repository and can clear the authorizer", async () => {
    const subject = fakeClients({
      GetAgentRuntimeCommand: () => CURRENT,
      GetRoleCommand: () => ({
        Role: {
          Arn: DEFAULT_ROLE,
          Tags: [{ ...CREATED_BY_TAG }, { Key: RUNTIME_TAG_KEY, Value: NAME }],
        },
      }),
      PutRolePolicyCommand: () => ({}),
      UpdateAgentRuntimeCommand: () => ({ agentRuntimeVersion: "4" }),
    });
    await subject.runtime.updateRuntime(
      { runtimeId: ID, containerUri: NEW_IMAGE, authorizerConfiguration: null },
      { region: REGION },
    );
    expect(subject.input("PutRolePolicyCommand").PolicyDocument).toContain("repository/agent-next");
    const update = subject.input("UpdateAgentRuntimeCommand");
    expect(update.agentRuntimeArtifact.containerConfiguration.containerUri).toBe(NEW_IMAGE);
    expect(update.authorizerConfiguration).toBeUndefined();
  });

  test("refuses a Runtime that was not created from a container image", async () => {
    const subject = fakeClients({
      GetAgentRuntimeCommand: () => ({
        ...CURRENT,
        agentRuntimeArtifact: { codeConfiguration: {} },
      }),
    });
    await expect(
      subject.runtime.updateRuntime({ runtimeId: ID }, { region: REGION }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("RuntimeClient.deleteRuntime", () => {
  test("deletes the default role only after the Runtime, and only when asked", async () => {
    const subject = fakeClients({
      GetAgentRuntimeCommand: () => CURRENT,
      DeleteAgentRuntimeCommand: () => ({ agentRuntimeId: ID, status: "DELETING" }),
      GetRoleCommand: () => ({
        Role: { Tags: [{ ...CREATED_BY_TAG }, { Key: RUNTIME_TAG_KEY, Value: NAME }] },
      }),
      DeleteRolePolicyCommand: () => ({}),
      DeleteRoleCommand: () => ({}),
    });
    const result = await subject.runtime.deleteRuntime(
      { runtimeId: ID, deleteExecutionRole: true },
      { region: REGION },
    );
    expect(subject.sent.map((entry) => entry.name)).toEqual([
      "GetAgentRuntimeCommand",
      "DeleteAgentRuntimeCommand",
      "GetRoleCommand",
      "DeleteRolePolicyCommand",
      "DeleteRoleCommand",
    ]);
    expect(result.executionRole).toEqual({ roleArn: DEFAULT_ROLE, deleted: true });
  });

  test("touches no IAM role without --delete-execution-role", async () => {
    const subject = fakeClients({
      DeleteAgentRuntimeCommand: () => ({ agentRuntimeId: ID, status: "DELETING" }),
    });
    const result = await subject.runtime.deleteRuntime({ runtimeId: ID }, { region: REGION });
    expect(subject.sent.map((entry) => entry.name)).toEqual(["DeleteAgentRuntimeCommand"]);
    expect(result).not.toHaveProperty("executionRole");
  });
});

describe("RuntimeClient.resolveRuntimeId", () => {
  test("takes an ID or ARN as is and looks a name up across pages", async () => {
    const subject = fakeClients({
      ListAgentRuntimesCommand: (input) =>
        input.nextToken
          ? { agentRuntimes: [{ agentRuntimeName: NAME, agentRuntimeId: ID }] }
          : {
              agentRuntimes: [{ agentRuntimeName: "other", agentRuntimeId: "x" }],
              nextToken: "p2",
            },
    });
    const options = { region: REGION };
    expect(await subject.runtime.resolveRuntimeId(ID, options)).toBe(ID);
    expect(await subject.runtime.resolveRuntimeId(CURRENT.agentRuntimeArn!, options)).toBe(ID);
    expect(subject.sent).toEqual([]);
    expect(await subject.runtime.resolveRuntimeId(NAME, options)).toBe(ID);
    expect(subject.sent).toHaveLength(2);
  });

  test("reports a name that matches no Runtime", async () => {
    const subject = fakeClients({ ListAgentRuntimesCommand: () => ({ agentRuntimes: [] }) });
    await expect(
      subject.runtime.resolveRuntimeId("missing", { region: REGION }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
