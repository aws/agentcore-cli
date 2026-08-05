import {
  CreateGatewayCommand,
  CreateGatewayRuleCommand,
  CreateGatewayTargetCommand,
  GetGatewayCommand,
  GetGatewayRuleCommand,
  GetGatewayTargetCommand,
  GetApiKeyCredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  ListGatewayRulesCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  type BedrockAgentCoreControlClient,
  type CreateGatewayResponse,
  type CreateGatewayRuleResponse,
  type CreateGatewayTargetResponse,
  type GetGatewayResponse,
  type GetGatewayRuleResponse,
  type GetGatewayTargetResponse,
  type ListGatewayRulesResponse,
  type ListGatewaysResponse,
  type ListGatewayTargetsResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  buildGatewayCreateRequest,
  validateGatewayCreateInput,
  validateGatewayTargetCreateInput,
} from "../handlers/gateway/mutations";
import type {
  CoreGatewayClient,
  CreateGatewayInput,
  CreateGatewayRuleInput,
  CreateGatewayTargetInput,
} from "../handlers/gateway/types";
import type { AwsClients, CoreOptions } from "./types";
import {
  ensureGatewayExecutionRole,
  getManagedGatewayTargetExecutionRole,
  retryWhileGatewayRoleChangesPropagate,
  type GatewayTargetRoleConfiguration,
} from "./gatewayExecutionRole";
import { toClientConfig } from "./utils";

export class GatewayClient implements CoreGatewayClient {
  constructor(private readonly clients: AwsClients) {}

  async createGateway(
    input: CreateGatewayInput,
    options: CoreOptions,
  ): Promise<CreateGatewayResponse> {
    validateGatewayCreateInput(input);
    const control = this.clients.control(toClientConfig(options));
    if (input.roleArn) {
      return control.send(
        new CreateGatewayCommand(buildGatewayCreateRequest({ ...input, roleArn: input.roleArn })),
      );
    }

    const iam = this.clients.iam({ region: options.region });
    const role = await ensureGatewayExecutionRole(iam, input.name!, options.region, input);
    await role.updatePolicy();
    const response = await retryWhileGatewayRoleChangesPropagate(() =>
      control.send(
        new CreateGatewayCommand(buildGatewayCreateRequest({ ...input, roleArn: role.roleArn })),
      ),
    );
    if (!response.gatewayArn) {
      throw new Error("CreateGateway response did not include the Gateway ARN");
    }
    await role.updatePolicy(response.gatewayArn);
    await role.updateTrust(response.gatewayArn);
    return response;
  }

  async getGateway(id: string, options: CoreOptions): Promise<GetGatewayResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetGatewayCommand({ gatewayIdentifier: id }));
  }

  async listGateways(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewaysResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListGatewaysCommand({ nextToken, maxResults }));
  }

  async getGatewayTarget(
    gatewayId: string,
    targetId: string,
    options: CoreOptions,
  ): Promise<GetGatewayTargetResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new GetGatewayTargetCommand({
        gatewayIdentifier: gatewayId,
        targetId,
      }),
    );
  }

  async listGatewayTargets(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayTargetsResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new ListGatewayTargetsCommand({
        gatewayIdentifier: gatewayId,
        nextToken,
        maxResults,
      }),
    );
  }

  async createGatewayTarget(
    input: CreateGatewayTargetInput,
    options: CoreOptions,
  ): Promise<CreateGatewayTargetResponse> {
    const request = validateGatewayTargetCreateInput(input);
    const control = this.clients.control(toClientConfig(options));
    const gateway = await control.send(
      new GetGatewayCommand({ gatewayIdentifier: request.gatewayIdentifier }),
    );
    const iam = this.clients.iam({ region: options.region });
    const role = await getManagedGatewayTargetExecutionRole(iam, gateway, options.region);
    if (!role) {
      return control.send(new CreateGatewayTargetCommand(request));
    }

    const configurations = await listTargetRoleConfigurations(
      control,
      request.gatewayIdentifier!,
      undefined,
      request,
    );
    await role.updatePolicy(configurations);
    return retryWhileGatewayRoleChangesPropagate(() =>
      control.send(new CreateGatewayTargetCommand(request)),
    );
  }

  async getGatewayRule(
    gatewayId: string,
    ruleId: string,
    options: CoreOptions,
  ): Promise<GetGatewayRuleResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new GetGatewayRuleCommand({
        gatewayIdentifier: gatewayId,
        ruleId,
      }),
    );
  }

  async listGatewayRules(
    gatewayId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListGatewayRulesResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new ListGatewayRulesCommand({
        gatewayIdentifier: gatewayId,
        nextToken,
        maxResults,
      }),
    );
  }

  async createGatewayRule(
    input: CreateGatewayRuleInput,
    options: CoreOptions,
  ): Promise<CreateGatewayRuleResponse> {
    return this.clients.control(toClientConfig(options)).send(new CreateGatewayRuleCommand(input));
  }
}

async function listTargetRoleConfigurations(
  control: BedrockAgentCoreControlClient,
  gatewayId: string,
  excludedTargetId?: string,
  replacement?: TargetRoleConfigurationSource,
): Promise<GatewayTargetRoleConfiguration[]> {
  const configurations: GatewayTargetRoleConfiguration[] = [];
  const providerSecrets = new Map<string, Promise<string | undefined>>();
  let nextToken: string | undefined;
  do {
    const page = await control.send(
      new ListGatewayTargetsCommand({
        gatewayIdentifier: gatewayId,
        nextToken,
        maxResults: 100,
      }),
    );
    const targets = await Promise.all(
      (page.items ?? [])
        .filter(({ targetId }) => targetId && targetId !== excludedTargetId)
        .map(({ targetId }) =>
          control.send(
            new GetGatewayTargetCommand({
              gatewayIdentifier: gatewayId,
              targetId,
            }),
          ),
        ),
    );
    configurations.push(
      ...(await Promise.all(
        targets.map((target) => targetRoleConfiguration(control, target, providerSecrets)),
      )),
    );
    nextToken = page.nextToken;
  } while (nextToken);

  if (replacement) {
    configurations.push(await targetRoleConfiguration(control, replacement, providerSecrets));
  }
  return configurations;
}

type TargetRoleConfigurationSource = Pick<
  CreateGatewayTargetInput,
  "targetConfiguration" | "credentialProviderConfigurations"
>;

async function targetRoleConfiguration(
  control: BedrockAgentCoreControlClient,
  target: TargetRoleConfigurationSource,
  providerSecrets = new Map<string, Promise<string | undefined>>(),
): Promise<GatewayTargetRoleConfiguration> {
  return {
    targetConfiguration: target.targetConfiguration,
    credentialProviderConfigurations: target.credentialProviderConfigurations,
    credentialProviderSecretArns: await credentialProviderSecretArns(
      control,
      target.credentialProviderConfigurations,
      providerSecrets,
    ),
  };
}

async function credentialProviderSecretArns(
  control: BedrockAgentCoreControlClient,
  configurations: CreateGatewayTargetInput["credentialProviderConfigurations"],
  cache: Map<string, Promise<string | undefined>>,
): Promise<string[]> {
  const providers = new Map<string, "oauth" | "apiKey">();
  for (const configuration of configurations ?? []) {
    const provider = configuration.credentialProvider;
    if (
      configuration.credentialProviderType === "OAUTH" &&
      provider &&
      "oauthCredentialProvider" in provider &&
      provider.oauthCredentialProvider?.providerArn
    ) {
      providers.set(provider.oauthCredentialProvider.providerArn, "oauth");
    } else if (
      configuration.credentialProviderType === "API_KEY" &&
      provider &&
      "apiKeyCredentialProvider" in provider &&
      provider.apiKeyCredentialProvider?.providerArn
    ) {
      providers.set(provider.apiKeyCredentialProvider.providerArn, "apiKey");
    }
  }

  const secrets = await Promise.all(
    [...providers].map(async ([providerArn, type]) => {
      const key = `${type}:${providerArn}`;
      let lookup = cache.get(key);
      if (!lookup) {
        lookup = lookupCredentialProviderSecret(control, providerArn, type);
        cache.set(key, lookup);
      }
      return lookup;
    }),
  );
  return secrets.filter((secretArn): secretArn is string => Boolean(secretArn));
}

async function lookupCredentialProviderSecret(
  control: BedrockAgentCoreControlClient,
  providerArn: string,
  type: "oauth" | "apiKey",
): Promise<string | undefined> {
  const name = credentialProviderName(providerArn);
  if (type === "oauth") {
    const provider = await control.send(new GetOauth2CredentialProviderCommand({ name }));
    return provider.clientSecretArn?.secretArn;
  }
  const provider = await control.send(new GetApiKeyCredentialProviderCommand({ name }));
  return provider.apiKeySecretArn?.secretArn;
}

function credentialProviderName(providerArn: string): string {
  const name = providerArn.split("/").at(-1);
  if (!name) throw new Error(`Invalid credential provider ARN "${providerArn}"`);
  return name;
}
