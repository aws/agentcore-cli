import { describe, expect, test } from "bun:test";
import { PutResourcePolicyCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  UpdateIndexingRuleCommand,
  UpdateTraceSegmentDestinationCommand,
} from "@aws-sdk/client-xray";
import { TransactionSearchSetupError } from "../errors";
import { enableTransactionSearch, type TransactionSearchClients } from "./transactionSearch";

// A recording harness: every client shares one `sent` log and looks its response
// (or an Error to throw) up by command name. Missing entries default to {}.
function harness(responses: Record<string, unknown> = {}): {
  clients: TransactionSearchClients;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const send = async (command: { constructor: { name: string } }): Promise<unknown> => {
    sent.push(command);
    const value = responses[command.constructor.name];
    if (value instanceof Error) throw value;
    return value ?? {};
  };
  const client = { send } as unknown as TransactionSearchClients["xray"];
  return { clients: { applicationSignals: client, logs: client, xray: client }, sent };
}

const PARAMS = { region: "us-west-2", accountId: "123456789012" };

describe("enableTransactionSearch", () => {
  test("runs the full setup in order on a fresh account", async () => {
    const { clients, sent } = harness();

    await enableTransactionSearch(clients, PARAMS);

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
    const { clients, sent } = harness({
      DescribeResourcePoliciesCommand: {
        resourcePolicies: [{ policyName: "TransactionSearchXRayAccess" }],
      },
    });

    await enableTransactionSearch(clients, PARAMS);

    expect(sent.some((c) => c instanceof PutResourcePolicyCommand)).toBe(false);
  });

  test("skips the destination update when already pointed at CloudWatch Logs", async () => {
    const { clients, sent } = harness({
      GetTraceSegmentDestinationCommand: { Destination: "CloudWatchLogs" },
    });

    await enableTransactionSearch(clients, PARAMS);

    expect(sent.some((c) => c instanceof UpdateTraceSegmentDestinationCommand)).toBe(false);
  });

  test("honors a custom indexing percentage", async () => {
    const { clients, sent } = harness();

    await enableTransactionSearch(clients, { ...PARAMS, indexPercentage: 25 });

    const rule = sent.find(
      (c) => c instanceof UpdateIndexingRuleCommand,
    ) as UpdateIndexingRuleCommand;
    expect(rule.input.Rule).toEqual({ Probabilistic: { DesiredSamplingPercentage: 25 } });
  });

  test("hard-fails with TransactionSearchSetupError naming the denied step", async () => {
    const denied = Object.assign(new Error("User is not authorized"), {
      name: "AccessDeniedException",
    });
    const { clients } = harness({ StartDiscoveryCommand: denied });

    const promise = enableTransactionSearch(clients, PARAMS);
    await expect(promise).rejects.toBeInstanceOf(TransactionSearchSetupError);
    await expect(promise).rejects.toThrow(/enable Application Signals.*not authorized/s);
  });

  test("uses the GovCloud partition for us-gov regions", async () => {
    const { clients, sent } = harness();

    await enableTransactionSearch(clients, { region: "us-gov-west-1", accountId: "123456789012" });

    const policy = JSON.parse((sent[2] as PutResourcePolicyCommand).input.policyDocument!) as {
      Statement: { Resource: string[] }[];
    };
    expect(policy.Statement[0]!.Resource[0]).toBe(
      "arn:aws-us-gov:logs:us-gov-west-1:123456789012:log-group:aws/spans:*",
    );
  });
});
