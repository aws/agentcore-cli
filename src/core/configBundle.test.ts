import { describe, expect, test } from "bun:test";
import {
  CreateConfigurationBundleCommand,
  DeleteConfigurationBundleCommand,
  GetConfigurationBundleCommand,
  GetConfigurationBundleVersionCommand,
  ListConfigurationBundlesCommand,
  ListConfigurationBundleVersionsCommand,
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
  test("create sends CreateConfigurationBundleCommand unchanged", async () => {
    const sent: unknown[] = [];
    const response = {
      bundleArn: "arn:bundle:b-1",
      bundleId: "b-1",
      versionId: "v-1",
      createdAt: new Date("2026-08-07T00:00:00Z"),
    };
    const { client, configs } = subject(async (command) => {
      sent.push(command);
      return response;
    });
    const input = {
      bundleName: "orders-prompt",
      components: COMPONENTS,
      kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/abc",
    };

    expect(await client.createConfigurationBundle(input, OPTIONS)).toBe(response);
    expect(sent[0]).toBeInstanceOf(CreateConfigurationBundleCommand);
    expect((sent[0] as CreateConfigurationBundleCommand).input).toEqual(input);
    expect(configs).toEqual([{ region: "us-west-2", endpoint: "https://control.test" }]);
  });

  test("get selects the latest or immutable-version SDK operation", async () => {
    const sent: unknown[] = [];
    const { client } = subject(async (command) => {
      sent.push(command);
      return {};
    });

    await client.getConfigurationBundle("b-1", undefined, OPTIONS);
    await client.getConfigurationBundle("b-1", "v-2", OPTIONS);

    expect(sent[0]).toBeInstanceOf(GetConfigurationBundleCommand);
    expect((sent[0] as GetConfigurationBundleCommand).input).toEqual({ bundleId: "b-1" });
    expect(sent[1]).toBeInstanceOf(GetConfigurationBundleVersionCommand);
    expect((sent[1] as GetConfigurationBundleVersionCommand).input).toEqual({
      bundleId: "b-1",
      versionId: "v-2",
    });
  });

  test("list sends only the aligned pagination fields", async () => {
    const sent: unknown[] = [];
    const { client } = subject(async (command) => {
      sent.push(command);
      return { bundles: [] };
    });

    await client.listConfigurationBundles("token-1", 10, OPTIONS);

    expect(sent[0]).toBeInstanceOf(ListConfigurationBundlesCommand);
    expect((sent[0] as ListConfigurationBundlesCommand).input).toEqual({
      nextToken: "token-1",
      maxResults: 10,
    });
  });

  test("update gets the latest version and sends it as the sole parent", async () => {
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
          components: COMPONENTS,
          commitMessage: "Replace order support configuration",
          kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/new",
        },
        OPTIONS,
      ),
    ).toBe(response);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBeInstanceOf(GetConfigurationBundleCommand);
    expect((sent[0] as GetConfigurationBundleCommand).input).toEqual({ bundleId: "b-1" });
    expect(sent[1]).toBeInstanceOf(UpdateConfigurationBundleCommand);
    expect((sent[1] as UpdateConfigurationBundleCommand).input).toEqual({
      bundleId: "b-1",
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
  });

  test("delete sends DeleteConfigurationBundleCommand", async () => {
    const sent: unknown[] = [];
    const response = { bundleId: "b-1", status: "DELETING" as const };
    const { client } = subject(async (command) => {
      sent.push(command);
      return response;
    });

    expect(await client.deleteConfigurationBundle("b-1", OPTIONS)).toBe(response);
    expect(sent[0]).toBeInstanceOf(DeleteConfigurationBundleCommand);
    expect((sent[0] as DeleteConfigurationBundleCommand).input).toEqual({ bundleId: "b-1" });
  });

  test("version list sends the parent bundle and pagination fields", async () => {
    const sent: unknown[] = [];
    const { client } = subject(async (command) => {
      sent.push(command);
      return { versions: [] };
    });

    await client.listConfigurationBundleVersions("b-1", "token-1", 5, OPTIONS);

    expect(sent[0]).toBeInstanceOf(ListConfigurationBundleVersionsCommand);
    expect((sent[0] as ListConfigurationBundleVersionsCommand).input).toEqual({
      bundleId: "b-1",
      nextToken: "token-1",
      maxResults: 5,
    });
  });
});
