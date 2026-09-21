import { describe, expect, test } from "bun:test";
import {
  DescribeResourcePoliciesCommand,
  PutResourcePolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  UpdateIndexingRuleCommand,
  UpdateTraceSegmentDestinationCommand,
} from "@aws-sdk/client-xray";
import { TransactionSearchSetupError } from "../../errors";
import { ObservabilityClient } from "./client";
import type { AwsClients } from "../types";

function harness(responses: Record<string, unknown> = {}): {
  observability: ObservabilityClient;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const send = async (command: { constructor: { name: string } }): Promise<unknown> => {
    sent.push(command);
    const value = responses[command.constructor.name];
    if (value instanceof Error) throw value;
    return value ?? {};
  };
  const client = { send };
  const factory = () => client;
  const clients = {
    applicationSignals: factory,
    logs: factory,
    xray: factory,
  } as unknown as AwsClients;
  return { observability: new ObservabilityClient(clients), sent };
}

const OPTIONS = { region: "us-west-2" };
const ACCOUNT = "123456789012";

describe("ObservabilityClient.enableTransactionSearch", () => {
  test("runs the full setup in order on a fresh account", async () => {
    const { observability, sent } = harness();

    await observability.enableTransactionSearch(OPTIONS, ACCOUNT);

    expect(sent.map((c) => (c as { constructor: { name: string } }).constructor.name)).toEqual([
      "StartDiscoveryCommand",
      "DescribeResourcePoliciesCommand",
      "PutResourcePolicyCommand",
      "GetTraceSegmentDestinationCommand",
      "UpdateTraceSegmentDestinationCommand",
      "UpdateIndexingRuleCommand",
    ]);

    const policy = JSON.parse((sent[2] as PutResourcePolicyCommand).input.policyDocument!) as {
      Statement: { Resource: string[]; Condition: { StringEquals: Record<string, string> } }[];
    };
    expect(policy.Statement[0]!.Resource).toEqual([
      "arn:aws:logs:us-west-2:123456789012:log-group:aws/spans:*",
      "arn:aws:logs:us-west-2:123456789012:log-group:/aws/application-signals/data:*",
    ]);
    expect(policy.Statement[0]!.Condition.StringEquals["aws:SourceAccount"]).toBe("123456789012");

    expect((sent[5] as UpdateIndexingRuleCommand).input.Rule).toEqual({
      Probabilistic: { DesiredSamplingPercentage: 100 },
    });
  });

  test("skips the resource policy when it already exists", async () => {
    const { observability, sent } = harness({
      DescribeResourcePoliciesCommand: {
        resourcePolicies: [{ policyName: "TransactionSearchXRayAccess" }],
      },
    });

    await observability.enableTransactionSearch(OPTIONS, ACCOUNT);

    expect(sent.some((c) => c instanceof PutResourcePolicyCommand)).toBe(false);
  });

  test("paginates DescribeResourcePolicies before deciding to add the policy", async () => {
    const pages = [
      { resourcePolicies: [{ policyName: "other" }], nextToken: "t2" },
      { resourcePolicies: [{ policyName: "TransactionSearchXRayAccess" }] },
    ];
    const sent: unknown[] = [];
    let describeCalls = 0;
    const send = async (command: { constructor: { name: string } }): Promise<unknown> => {
      sent.push(command);
      if (command instanceof DescribeResourcePoliciesCommand) return pages[describeCalls++];
      return {};
    };
    const factory = () => ({ send });
    const clients = {
      applicationSignals: factory,
      logs: factory,
      xray: factory,
    } as unknown as AwsClients;

    await new ObservabilityClient(clients).enableTransactionSearch(OPTIONS, ACCOUNT);

    expect(describeCalls).toBe(2);
    expect(sent.some((c) => c instanceof PutResourcePolicyCommand)).toBe(false);
  });

  test("skips the destination update when already pointed at CloudWatch Logs", async () => {
    const { observability, sent } = harness({
      GetTraceSegmentDestinationCommand: { Destination: "CloudWatchLogs", Status: "ACTIVE" },
    });

    await observability.enableTransactionSearch(OPTIONS, ACCOUNT);

    expect(sent.some((c) => c instanceof UpdateTraceSegmentDestinationCommand)).toBe(false);
  });

  test("honors a custom indexing percentage", async () => {
    const { observability, sent } = harness();

    await observability.enableTransactionSearch(OPTIONS, ACCOUNT, 25);

    const rule = sent.find(
      (c) => c instanceof UpdateIndexingRuleCommand,
    ) as UpdateIndexingRuleCommand;
    expect(rule.input.Rule).toEqual({ Probabilistic: { DesiredSamplingPercentage: 25 } });
  });

  test("leaves indexing untouched when Transaction Search is already on", async () => {
    const { observability, sent } = harness({
      GetTraceSegmentDestinationCommand: { Destination: "CloudWatchLogs", Status: "ACTIVE" },
    });

    await observability.enableTransactionSearch(OPTIONS, ACCOUNT);

    expect(sent.some((c) => c instanceof UpdateIndexingRuleCommand)).toBe(false);
  });

  test("hard-fails with TransactionSearchSetupError naming the denied step", async () => {
    const denied = Object.assign(new Error("User is not authorized"), {
      name: "AccessDeniedException",
    });
    const { observability } = harness({ StartDiscoveryCommand: denied });

    const promise = observability.enableTransactionSearch(OPTIONS, ACCOUNT);
    await expect(promise).rejects.toBeInstanceOf(TransactionSearchSetupError);
    await expect(promise).rejects.toThrow(/enable Application Signals.*not authorized/s);
  });

  test("uses the GovCloud partition for us-gov regions", async () => {
    const { observability, sent } = harness();

    await observability.enableTransactionSearch({ region: "us-gov-west-1" }, ACCOUNT);

    const policy = JSON.parse((sent[2] as PutResourcePolicyCommand).input.policyDocument!) as {
      Statement: { Resource: string[] }[];
    };
    expect(policy.Statement[0]!.Resource[0]).toBe(
      "arn:aws-us-gov:logs:us-gov-west-1:123456789012:log-group:aws/spans:*",
    );
  });
});
