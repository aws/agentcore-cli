import { describe, expect, test } from "bun:test";
import { GetPaymentConnectorCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import type { CreateCloudFormationClient, CreateControlClient } from "../../../types";
import { createPaymentConnectorAuthorizationUrlReporter } from "./paymentConnectorAuthorizationUrls";
import type { CdkCredentialProvider } from "./toolkit";

const REGION = "us-east-1";
const STACK = "AgentCore-example-default";
const CREDENTIALS: CdkCredentialProvider = async () => ({
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
});
const CONNECTOR_ARN =
  "arn:aws:bedrock-agentcore:us-east-1:111122223333:" +
  "payment-manager/payments-abc123def4/connector/quick-abc123def4";

type Send = (command: unknown) => Promise<unknown>;

function client(send: Send): never {
  return { send } as never;
}

function project(quickCreate = true): Project {
  const connectors = quickCreate
    ? [{ name: "quick", provider: "CoinbaseCDP", provisionMode: "QUICK_CREATE" }]
    : [];
  return {
    name: "example",
    rootPath: "/tmp/example",
    spec: ProjectSpecSchema.parse({
      name: "example",
      version: 1,
      payments: [{ name: "payments", authorizerType: "AWS_IAM", connectors }],
    }),
  };
}

async function report(input: Project, stackSend: Send, paymentsSend: Send): Promise<string[]> {
  const createStackClient = (() => client(stackSend)) as CreateCloudFormationClient;
  const createPaymentsClient = (() => client(paymentsSend)) as CreateControlClient;
  const generator = createPaymentConnectorAuthorizationUrlReporter(
    createStackClient,
    createPaymentsClient,
  )(input, {
    stackName: STACK,
    region: REGION,
    credentials: CREDENTIALS,
  });
  const messages: string[] = [];
  while (true) {
    const next: IteratorResult<ProjectEvent, void> = await generator.next();
    if (next.done) return messages;
    if (next.value.type === "step") messages.push(next.value.message);
  }
}

describe("Quick Create authorization reporting", () => {
  test("prints the live authorization URL returned by GetPaymentConnector", async () => {
    const messages = await report(
      project(),
      async (command) => {
        expect(command).toBeInstanceOf(ListStackResourcesCommand);
        const input = (command as ListStackResourcesCommand).input;
        if (!input.NextToken) {
          return {
            StackResourceSummaries: [
              { ResourceType: "AWS::IAM::Role", PhysicalResourceId: "role" },
            ],
            NextToken: "next",
          };
        }
        return {
          StackResourceSummaries: [
            {
              ResourceType: "AWS::BedrockAgentCore::PaymentConnector",
              PhysicalResourceId: CONNECTOR_ARN,
            },
          ],
        };
      },
      async (command) => {
        expect(command).toBeInstanceOf(GetPaymentConnectorCommand);
        expect((command as GetPaymentConnectorCommand).input).toEqual({
          paymentManagerId: "payments-abc123def4",
          paymentConnectorId: "quick-abc123def4",
        });
        return {
          name: "quick",
          authorizationUrl: "https://example.com/authorize?request_uri=urn:x",
        };
      },
    );

    expect(messages).toEqual([
      'Authorize payment connector "quick": https://example.com/authorize?request_uri=urn:x',
    ]);
  });

  test("prints nothing when GetPaymentConnector has no authorization URL", async () => {
    const messages = await report(
      project(),
      async () => ({
        StackResourceSummaries: [
          {
            ResourceType: "AWS::BedrockAgentCore::PaymentConnector",
            PhysicalResourceId: CONNECTOR_ARN,
          },
        ],
      }),
      async () => ({ name: "quick", status: "READY" }),
    );

    expect(messages).toEqual([]);
  });

  test("makes no calls when the project declares no Quick Create connector", async () => {
    let called = false;
    const messages = await report(
      project(false),
      async () => {
        called = true;
        return {};
      },
      async () => {
        called = true;
        return {};
      },
    );

    expect(called).toBe(false);
    expect(messages).toEqual([]);
  });

  test("ignores unrelated resources and malformed connector physical IDs", async () => {
    let paymentCalls = 0;
    const messages = await report(
      project(),
      async () => ({
        StackResourceSummaries: [
          { ResourceType: "AWS::IAM::Role", PhysicalResourceId: CONNECTOR_ARN },
          {
            ResourceType: "AWS::BedrockAgentCore::PaymentConnector",
            PhysicalResourceId: "not-a-connector-arn",
          },
        ],
      }),
      async () => {
        paymentCalls += 1;
        return {};
      },
    );

    expect(paymentCalls).toBe(0);
    expect(messages).toEqual([]);
  });

  test("reports retrieval failure without failing the completed deployment", async () => {
    const messages = await report(
      project(),
      async () => {
        throw new Error("AccessDenied");
      },
      async () => ({}),
    );

    expect(messages).toEqual([
      "Deployed, but payment connector authorization URLs could not be retrieved: AccessDenied",
    ]);
  });
});
