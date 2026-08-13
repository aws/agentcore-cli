import { describe, expect, test } from "bun:test";
import {
  GetConfigurationBundleCommand,
  GetConfigurationBundleVersionCommand,
  UpdateConfigurationBundleCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { NetworkingError } from "../errors";
import { EvalClient } from "./eval";
import type { AwsClients, ClientConfig } from "./types";

const OPTIONS = { region: "us-west-2", endpointUrl: "https://control.test" };
const COMPONENTS = {
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/orders-agent": {
    configuration: { system_prompt: "Help with orders." },
  },
};

function subject(respond: (command: unknown) => Promise<unknown>): {
  client: EvalClient;
  configs: ClientConfig[];
} {
  const configs: ClientConfig[] = [];
  const control = { send: respond } as unknown as BedrockAgentCoreControlClient;
  const clients = {
    control: (config: ClientConfig) => {
      configs.push(config);
      return control;
    },
  } as unknown as AwsClients;
  return { client: new EvalClient(clients), configs };
}

describe("EvalClient configuration bundles", () => {
  test("get passes an explicit branch or selects the immutable-version operation", async () => {
    const sent: unknown[] = [];
    const { client } = subject(async (command) => {
      sent.push(command);
      return {};
    });

    await client.getConfigurationBundle("b-1", undefined, "review-branch", OPTIONS);
    await client.getConfigurationBundle("b-1", "v-2", "mainline", OPTIONS);

    expect(sent[0]).toBeInstanceOf(GetConfigurationBundleCommand);
    expect((sent[0] as GetConfigurationBundleCommand).input).toEqual({
      bundleId: "b-1",
      branchName: "review-branch",
    });
    expect(sent[1]).toBeInstanceOf(GetConfigurationBundleVersionCommand);
    expect((sent[1] as GetConfigurationBundleVersionCommand).input).toEqual({
      bundleId: "b-1",
      versionId: "v-2",
    });
  });

  test("update uses the same explicit branch for the parent lookup and update", async () => {
    const sent: unknown[] = [];
    const response = {
      bundleArn: "arn:bundle:b-1",
      bundleId: "b-1",
      versionId: "v-3",
      updatedAt: new Date("2026-08-07T00:00:00Z"),
    };
    const { client } = subject(async (command) => {
      sent.push(command);
      if (command instanceof GetConfigurationBundleCommand) {
        return {
          versionId: "v-2",
          lineageMetadata: { branchName: "custom-branch" },
        };
      }
      return response;
    });

    expect(
      await client.updateConfigurationBundle(
        "b-1",
        {
          branchName: "review-branch",
          components: COMPONENTS,
          commitMessage: "Replace order support configuration",
          kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/new",
        },
        OPTIONS,
      ),
    ).toBe(response);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBeInstanceOf(GetConfigurationBundleCommand);
    expect((sent[0] as GetConfigurationBundleCommand).input).toEqual({
      bundleId: "b-1",
      branchName: "review-branch",
    });
    expect(sent[1]).toBeInstanceOf(UpdateConfigurationBundleCommand);
    expect((sent[1] as UpdateConfigurationBundleCommand).input).toEqual({
      bundleId: "b-1",
      branchName: "review-branch",
      components: COMPONENTS,
      commitMessage: "Replace order support configuration",
      kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/new",
      parentVersionIds: ["v-2"],
    });
  });

  test("update fails before sending when latest has no version id", async () => {
    const sent: unknown[] = [];
    const { client } = subject(async (command) => {
      sent.push(command);
      return {};
    });

    const promise = client.updateConfigurationBundle(
      "b-1",
      {
        branchName: "mainline",
        components: COMPONENTS,
        commitMessage: "Replace order support configuration",
        kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/new",
      },
      OPTIONS,
    );

    await expect(promise).rejects.toBeInstanceOf(NetworkingError);
    await expect(promise).rejects.toThrow(/returned no latest version/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(GetConfigurationBundleCommand);
    expect((sent[0] as GetConfigurationBundleCommand).input).toEqual({
      bundleId: "b-1",
      branchName: "mainline",
    });
  });
});
