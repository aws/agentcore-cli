import { describe, expect, test } from "bun:test";
import type { Stack } from "@aws-sdk/client-cloudformation";
import type { Project } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import type { TargetState } from "./deployedState";
import { projectDevEnvironment } from "./devEnvironment";

function project(overrides: Partial<Project["spec"]> = {}): Project {
  return {
    name: "orders",
    rootPath: "/workspace/orders",
    spec: {
      ...ProjectSpecSchema.parse({ name: "orders", version: 2 }),
      ...overrides,
    },
  };
}

const configuredProject = project({
  memories: [{ name: "order_history" }],
  agentCoreGateways: [
    {
      name: "tools-gateway",
      authorizerType: "AWS_IAM",
      protocolType: "MCP",
      targets: [],
    },
  ],
  payments: [
    {
      name: "Billing",
      authorizerType: "CUSTOM_JWT",
      connectors: [
        {
          name: "primary_wallet",
          provider: "CoinbaseCDP",
          provisionMode: "QUICK_CREATE",
        },
      ],
      autoPayment: true,
      defaultSpendLimit: "10.00",
      paymentToolAllowlist: ["pay"],
      networkPreferences: ["eip155:1"],
    },
  ],
} as unknown as Partial<Project["spec"]>);

describe("projectDevEnvironment", () => {
  test("reads the v0 memory, gateway, and payment state", () => {
    const recorded = {
      resources: {
        memories: {
          order_history: {
            memoryId: "memory-1",
            memoryArn: "arn:memory/memory-1",
          },
        },
        mcp: {
          gateways: {
            "tools-gateway": {
              gatewayId: "gateway-1",
              gatewayArn: "arn:gateway/gateway-1",
              gatewayUrl: "https://gateway.example.test",
            },
          },
        },
        payments: {
          Billing: {
            managerId: "billing-1",
            managerArn: "arn:payment/billing-1",
            processPaymentRoleArn: "arn:role/process-payment",
            resourceRetrievalRoleArn: "arn:role/resource-retrieval",
            authorizerType: "AWS_IAM",
            autoPayment: false,
            paymentToolAllowlist: ["refund"],
            networkPreferences: ["eip155:8453"],
            connectors: {
              primary_wallet: {
                connectorId: "connector-1",
                provisionMode: "QUICK_CREATE",
              },
            },
          },
        },
      },
    } as TargetState;

    expect(projectDevEnvironment({ project: configuredProject, recorded })).toEqual({
      MEMORY_ORDER_HISTORY_ID: "memory-1",
      AGENTCORE_GATEWAY_TOOLS_GATEWAY_URL: "https://gateway.example.test",
      AGENTCORE_GATEWAY_TOOLS_GATEWAY_AUTH_TYPE: "AWS_IAM",
      AGENTCORE_PAYMENT_BILLING_MANAGER_ARN: "arn:payment/billing-1",
      AGENTCORE_PAYMENT_BILLING_PROCESS_PAYMENT_ROLE_ARN: "arn:role/process-payment",
      AGENTCORE_PAYMENT_BILLING_CONNECTOR_ID: "connector-1",
      AGENTCORE_PAYMENT_BILLING_AUTO_PAYMENT: "false",
      AGENTCORE_PAYMENT_BILLING_TOOL_ALLOWLIST: "refund",
      AGENTCORE_PAYMENT_BILLING_NETWORK_PREFERENCES: "eip155:8453",
    });
  });

  test("keeps discovering v0 resources that are only present in deployed state", () => {
    const recorded = {
      resources: {
        memories: {
          "removed-memory": {
            memoryId: "memory-legacy",
          },
        },
        mcp: {
          gateways: {
            "removed-gateway": {
              gatewayUrl: "https://legacy-gateway.example.test",
            },
          },
        },
        gateways: {
          "removed-gateway": {
            gatewayUrl: "https://stale-layout.example.test",
          },
        },
        payments: {
          "removed-payment": {
            managerArn: "arn:payment/legacy",
            connectors: {
              "first-connector": { connectorId: "connector-first" },
              "second-connector": { connectorId: "connector-second" },
            },
            paymentToolAllowlist: [],
            networkPreferences: [],
          },
        },
      },
    } as TargetState;

    expect(projectDevEnvironment({ project: project(), recorded })).toEqual({
      MEMORY_REMOVED_MEMORY_ID: "memory-legacy",
      AGENTCORE_GATEWAY_REMOVED_GATEWAY_URL: "https://legacy-gateway.example.test",
      AGENTCORE_GATEWAY_REMOVED_GATEWAY_AUTH_TYPE: "NONE",
      AGENTCORE_PAYMENT_REMOVED_PAYMENT_MANAGER_ARN: "arn:payment/legacy",
      AGENTCORE_PAYMENT_REMOVED_PAYMENT_CONNECTOR_ID: "connector-first",
    });
  });

  test("falls back to v1 CloudFormation outputs", () => {
    const stack = {
      StackName: "AgentCore-orders-default",
      Outputs: [
        {
          ExportName: "AgentCore-orders-default-Memory-order-history-Id",
          OutputValue: "memory-2",
        },
        {
          ExportName: "AgentCore-orders-default-Gateway-tools-gateway-Url",
          OutputValue: "https://v1-gateway.example.test",
        },
        { OutputKey: "PaymentBillingManagerArn", OutputValue: "arn:payment/billing-2" },
        {
          OutputKey: "PaymentBillingProcessPaymentRoleArn",
          OutputValue: "arn:role/process-payment-2",
        },
        {
          OutputKey: "PaymentBillingprimarywalletConnectorId",
          OutputValue: "connector-2",
        },
      ],
    } as Stack;

    expect(projectDevEnvironment({ project: configuredProject, stack })).toEqual({
      MEMORY_ORDER_HISTORY_ID: "memory-2",
      AGENTCORE_GATEWAY_TOOLS_GATEWAY_URL: "https://v1-gateway.example.test",
      AGENTCORE_GATEWAY_TOOLS_GATEWAY_AUTH_TYPE: "AWS_IAM",
      AGENTCORE_PAYMENT_BILLING_MANAGER_ARN: "arn:payment/billing-2",
      AGENTCORE_PAYMENT_BILLING_PROCESS_PAYMENT_ROLE_ARN: "arn:role/process-payment-2",
      AGENTCORE_PAYMENT_BILLING_CONNECTOR_ID: "connector-2",
      AGENTCORE_PAYMENT_BILLING_AUTO_PAYMENT: "true",
      AGENTCORE_PAYMENT_BILLING_TOOL_ALLOWLIST: "pay",
      AGENTCORE_PAYMENT_BILLING_NETWORK_PREFERENCES: "eip155:1",
      AGENTCORE_PAYMENT_BILLING_AUTH_MODE: "bearer",
    });
  });

  test("omits empty v1 payment list settings", () => {
    const withoutLists = project({
      payments: [
        {
          name: "Billing",
          authorizerType: "AWS_IAM",
          connectors: [],
          autoPayment: false,
          defaultSpendLimit: "10.00",
          paymentToolAllowlist: [],
          networkPreferences: [],
        },
      ],
    } as unknown as Partial<Project["spec"]>);
    const stack = {
      StackName: "AgentCore-orders-default",
      Outputs: [{ OutputKey: "PaymentBillingManagerArn", OutputValue: "arn:payment/billing" }],
    } as Stack;

    expect(projectDevEnvironment({ project: withoutLists, stack })).toEqual({
      AGENTCORE_PAYMENT_BILLING_MANAGER_ARN: "arn:payment/billing",
      AGENTCORE_PAYMENT_BILLING_AUTO_PAYMENT: "false",
    });
  });

  test("rejects resource names that collide after environment sanitization", () => {
    const colliding = project({
      agentCoreGateways: [
        { name: "Tools", authorizerType: "NONE", protocolType: "MCP", targets: [] },
        { name: "tools", authorizerType: "NONE", protocolType: "MCP", targets: [] },
      ],
    } as unknown as Partial<Project["spec"]>);
    const stack = {
      StackName: "AgentCore-orders-default",
      Outputs: [
        {
          ExportName: "AgentCore-orders-default-Gateway-Tools-Url",
          OutputValue: "https://first.example.test",
        },
        {
          ExportName: "AgentCore-orders-default-Gateway-tools-Url",
          OutputValue: "https://second.example.test",
        },
      ],
    } as Stack;

    expect(() => projectDevEnvironment({ project: colliding, stack })).toThrow(
      "both map to environment variable AGENTCORE_GATEWAY_TOOLS_URL",
    );
  });
});
