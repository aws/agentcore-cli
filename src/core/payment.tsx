import {
  CreatePaymentConnectorCommand,
  CreatePaymentManagerCommand,
  DeletePaymentConnectorCommand,
  DeletePaymentManagerCommand,
  GetPaymentConnectorCommand,
  GetPaymentManagerCommand,
  ListPaymentConnectorsCommand,
  ListPaymentManagersCommand,
  UpdatePaymentConnectorCommand,
  UpdatePaymentManagerCommand,
  type CreatePaymentConnectorResponse,
  type CreatePaymentManagerResponse,
  type CredentialsProviderConfiguration,
  type DeletePaymentConnectorRequest,
  type DeletePaymentConnectorResponse,
  type DeletePaymentManagerRequest,
  type DeletePaymentManagerResponse,
  type GetPaymentConnectorResponse,
  type GetPaymentManagerResponse,
  type ListPaymentConnectorsResponse,
  type ListPaymentManagersResponse,
  type PaymentConnectorType,
  type UpdatePaymentConnectorResponse,
  type UpdatePaymentManagerResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  CreatePaymentInstrumentCommand,
  CreatePaymentSessionCommand,
  DeletePaymentInstrumentCommand,
  DeletePaymentSessionCommand,
  GetPaymentInstrumentBalanceCommand,
  GetPaymentInstrumentCommand,
  GetPaymentSessionCommand,
  ListPaymentInstrumentsCommand,
  ListPaymentSessionsCommand,
  type BedrockAgentCoreClient,
  type CreatePaymentInstrumentResponse,
  type CreatePaymentSessionResponse,
  type DeletePaymentInstrumentResponse,
  type DeletePaymentSessionResponse,
  type GetPaymentInstrumentResponse,
  type GetPaymentInstrumentBalanceResponse,
  type GetPaymentSessionResponse,
  type ListPaymentInstrumentsResponse,
  type ListPaymentSessionsResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  AgentCoreCLIError,
  ERROR_SOURCE,
  InputValidationError,
  MalformedServiceResponseError,
} from "../errors";
import type { CoreIdentityClient } from "../handlers/identity/types";
import type {
  CorePaymentClient,
  CreatePaymentConnectorInput,
  CreatePaymentManagerInput,
  CreatePaymentSessionInput,
  GetPaymentSessionInput,
  ListPaymentSessionsInput,
  DeletePaymentSessionInput,
  CreatePaymentInstrumentInput,
  GetPaymentInstrumentInput,
  GetPaymentInstrumentBalanceInput,
  ListPaymentInstrumentsInput,
  DeletePaymentInstrumentInput,
  UpdatePaymentConnectorInput,
  UpdatePaymentManagerInput,
} from "../handlers/payment/types";
import { ensurePaymentServiceRole } from "./paymentServiceRole";
import { isRoleUnassumableValidation, retryWhileRoleUnassumable } from "./roleRetry";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

const QUICK_CREATE_TYPE: PaymentConnectorType = "CoinbaseCDP";

// PaymentClient implements the payment-facing operations on top of the shared
// AWS clients provided by CoreClient. Managers and connectors live on the control
// plane; sessions and instruments on the data plane.
export class PaymentClient implements CorePaymentClient {
  constructor(
    private readonly clients: Pick<AwsClients, "control" | "data" | "iam">,
    // Payment credential providers live in AgentCore Identity. Connector create
    // and update resolve a provider name to its ARN and vendor through the
    // identity client rather than re-implementing that lookup here.
    private readonly identity: Pick<CoreIdentityClient, "getPaymentCredentialProvider">,
  ) {}

  // ─── payment managers ───────────────────────────────────────────────────────

  async createPaymentManager(
    input: CreatePaymentManagerInput,
    options: CoreOptions,
  ): Promise<CreatePaymentManagerResponse> {
    const control = this.clients.control(toClientConfig(options));
    const { roleArn, ...request } = input;
    if (roleArn) {
      return control.send(new CreatePaymentManagerCommand({ ...request, roleArn }));
    }

    // No role supplied: provision (or reuse) the default service role, then
    // create the manager with it. IAM is eventually consistent — a role created
    // moments ago may not yet be assumable by the service principal — so retry
    // the create while the service reports the role as unusable.
    const defaultRoleArn = await ensurePaymentServiceRole(
      // IAM is a global service; the region only selects the endpoint, and the
      // agentcore endpoint override must not leak onto it.
      this.clients.iam({
        region: options.region,
        ...(options.credentials ? { credentials: options.credentials } : {}),
      }),
      input.name!,
      options.region,
    );
    return retryWhileRoleUnassumable(
      () => control.send(new CreatePaymentManagerCommand({ ...request, roleArn: defaultRoleArn })),
      isServiceRoleUnusable(defaultRoleArn),
    );
  }

  async getPaymentManager(id: string, options: CoreOptions): Promise<GetPaymentManagerResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new GetPaymentManagerCommand({ paymentManagerId: id }));
  }

  async listPaymentManagers(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListPaymentManagersResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new ListPaymentManagersCommand({ nextToken, maxResults }));
  }

  async updatePaymentManager(
    input: UpdatePaymentManagerInput,
    options: CoreOptions,
  ): Promise<UpdatePaymentManagerResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new UpdatePaymentManagerCommand({ ...input }));
  }

  async deletePaymentManager(
    request: DeletePaymentManagerRequest,
    options: CoreOptions,
  ): Promise<DeletePaymentManagerResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeletePaymentManagerCommand({ ...request }));
  }

  // ─── payment connectors ─────────────────────────────────────────────────────

  async createPaymentConnector(
    input: CreatePaymentConnectorInput,
    options: CoreOptions,
  ): Promise<CreatePaymentConnectorResponse> {
    const { type, credentialProviderConfigurations } = await this.resolveConnectorCredentials(
      input,
      options,
    );
    try {
      return await this.clients.control(toClientConfig(options)).send(
        new CreatePaymentConnectorCommand({
          paymentManagerId: input.managerId,
          name: input.name,
          ...(input.description !== undefined ? { description: input.description } : {}),
          type,
          credentialProviderConfigurations,
          provisionMode: input.quickCreate ? "QUICK_CREATE" : undefined,
          ...(input.clientToken !== undefined ? { clientToken: input.clientToken } : {}),
        }),
      );
    } catch (error) {
      throw subscriptionRequired(error);
    }
  }

  async getPaymentConnector(
    managerId: string,
    connectorId: string,
    options: CoreOptions,
  ): Promise<GetPaymentConnectorResponse> {
    return this.clients.control(toClientConfig(options)).send(
      new GetPaymentConnectorCommand({
        paymentManagerId: managerId,
        paymentConnectorId: connectorId,
      }),
    );
  }

  async listPaymentConnectors(
    managerId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListPaymentConnectorsResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(
        new ListPaymentConnectorsCommand({ paymentManagerId: managerId, nextToken, maxResults }),
      );
  }

  async updatePaymentConnector(
    input: UpdatePaymentConnectorInput,
    options: CoreOptions,
  ): Promise<UpdatePaymentConnectorResponse> {
    const control = this.clients.control(toClientConfig(options));

    // A replacement credential provider has to land in the union member matching
    // the connector's type, and the type is not changeable, so read it first.
    let credentialProviderConfigurations: CredentialsProviderConfiguration[] | undefined;
    if (input.credentialProvider !== undefined) {
      const current = await control.send(
        new GetPaymentConnectorCommand({
          paymentManagerId: input.managerId,
          paymentConnectorId: input.connectorId,
        }),
      );
      if (!current.type) {
        throw new AgentCoreCLIError(
          `payment connector "${input.connectorId}" returned no type; cannot choose a credential configuration`,
          { source: ERROR_SOURCE.SERVICE },
        );
      }
      const resolved = await this.resolveCredentialProvider(
        input.credentialProvider,
        current.type,
        options,
      );
      credentialProviderConfigurations = [credentialConfiguration(current.type, resolved.arn)];
    }

    try {
      return await control.send(
        new UpdatePaymentConnectorCommand({
          paymentManagerId: input.managerId,
          paymentConnectorId: input.connectorId,
          description: input.description,
          credentialProviderConfigurations,
          clientToken: input.clientToken,
        }),
      );
    } catch (error) {
      throw subscriptionRequired(error);
    }
  }

  async deletePaymentConnector(
    request: DeletePaymentConnectorRequest,
    options: CoreOptions,
  ): Promise<DeletePaymentConnectorResponse> {
    return this.clients
      .control(toClientConfig(options))
      .send(new DeletePaymentConnectorCommand({ ...request }));
  }

  // ─── payment sessions (data plane) ──────────────────────────────────────────

  async createPaymentSession(
    input: CreatePaymentSessionInput,
    options: CoreOptions,
  ): Promise<CreatePaymentSessionResponse> {
    const { managerId, ...request } = input;
    return this.sendData(managerId, options, (data, paymentManagerArn) =>
      data.send(new CreatePaymentSessionCommand({ paymentManagerArn, ...request })),
    );
  }

  async getPaymentSession(
    input: GetPaymentSessionInput,
    options: CoreOptions,
  ): Promise<GetPaymentSessionResponse> {
    const { managerId, ...request } = input;
    return this.sendData(managerId, options, (data, paymentManagerArn) =>
      data.send(new GetPaymentSessionCommand({ paymentManagerArn, ...request })),
    );
  }

  async listPaymentSessions(
    input: ListPaymentSessionsInput,
    options: CoreOptions,
  ): Promise<ListPaymentSessionsResponse> {
    const { managerId, ...request } = input;
    return this.sendData(managerId, options, (data, paymentManagerArn) =>
      data.send(new ListPaymentSessionsCommand({ paymentManagerArn, ...request })),
    );
  }

  async deletePaymentSession(
    input: DeletePaymentSessionInput,
    options: CoreOptions,
  ): Promise<DeletePaymentSessionResponse> {
    const { managerId, ...request } = input;
    return this.sendData(managerId, options, (data, paymentManagerArn) =>
      data.send(new DeletePaymentSessionCommand({ paymentManagerArn, ...request })),
    );
  }

  // ─── payment instruments (data plane) ───────────────────────────────────────

  async createPaymentInstrument(
    input: CreatePaymentInstrumentInput,
    options: CoreOptions,
  ): Promise<CreatePaymentInstrumentResponse> {
    const { managerId, ...request } = input;
    return this.sendData(managerId, options, (data, paymentManagerArn) =>
      data.send(new CreatePaymentInstrumentCommand({ paymentManagerArn, ...request })),
    );
  }

  async getPaymentInstrument(
    input: GetPaymentInstrumentInput,
    options: CoreOptions,
  ): Promise<GetPaymentInstrumentResponse> {
    const { managerId, ...request } = input;
    return this.sendData(managerId, options, (data, paymentManagerArn) =>
      data.send(new GetPaymentInstrumentCommand({ paymentManagerArn, ...request })),
    );
  }

  async getPaymentInstrumentBalance(
    input: GetPaymentInstrumentBalanceInput,
    options: CoreOptions,
  ): Promise<GetPaymentInstrumentBalanceResponse> {
    const { managerId, ...request } = input;
    return this.sendData(managerId, options, (data, paymentManagerArn) =>
      data.send(new GetPaymentInstrumentBalanceCommand({ paymentManagerArn, ...request })),
    );
  }

  async listPaymentInstruments(
    input: ListPaymentInstrumentsInput,
    options: CoreOptions,
  ): Promise<ListPaymentInstrumentsResponse> {
    const { managerId, ...request } = input;
    return this.sendData(managerId, options, (data, paymentManagerArn) =>
      data.send(new ListPaymentInstrumentsCommand({ paymentManagerArn, ...request })),
    );
  }

  async deletePaymentInstrument(
    input: DeletePaymentInstrumentInput,
    options: CoreOptions,
  ): Promise<DeletePaymentInstrumentResponse> {
    const { managerId, ...request } = input;
    return this.sendData(managerId, options, (data, paymentManagerArn) =>
      data.send(new DeletePaymentInstrumentCommand({ paymentManagerArn, ...request })),
    );
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  private async resolveConnectorCredentials(
    input: Pick<CreatePaymentConnectorInput, "type" | "credentialProvider" | "quickCreate">,
    options: CoreOptions,
  ): Promise<{
    type: PaymentConnectorType;
    credentialProviderConfigurations: CredentialsProviderConfiguration[];
  }> {
    if (input.quickCreate && input.credentialProvider !== undefined) {
      throw new InputValidationError(
        "Quick Create and a credential provider are mutually exclusive; specify one",
      );
    }
    if (input.quickCreate) {
      const type = input.type ?? QUICK_CREATE_TYPE;
      if (type !== QUICK_CREATE_TYPE) {
        throw new InputValidationError(
          `Quick Create is available only for ${QUICK_CREATE_TYPE} connectors, not ${type}`,
        );
      }
      return { type, credentialProviderConfigurations: [] };
    }
    if (input.credentialProvider === undefined) {
      throw new InputValidationError(
        "a payment connector needs a credential provider, or Quick Create for CoinbaseCDP",
      );
    }
    const resolved = await this.resolveCredentialProvider(
      input.credentialProvider,
      input.type,
      options,
    );
    return {
      type: resolved.type,
      credentialProviderConfigurations: [credentialConfiguration(resolved.type, resolved.arn)],
    };
  }

  // resolveCredentialProvider turns a provider reference into an ARN plus the
  // connector type it backs. An ARN carries no vendor, so the type must come from
  // the caller; a name is looked up in identity and its vendor is the type,
  // which an explicit type must agree with.
  private async resolveCredentialProvider(
    reference: string,
    type: PaymentConnectorType | undefined,
    options: CoreOptions,
  ): Promise<{ arn: string; type: PaymentConnectorType }> {
    if (reference.startsWith("arn:")) {
      if (!type) {
        throw new InputValidationError(
          "--type is required when --credential-provider is an ARN (the ARN does not name the vendor)",
        );
      }
      return { arn: reference, type };
    }

    const provider = await this.identity.getPaymentCredentialProvider(reference, options);
    const arn = provider.credentialProviderArn;
    const vendor = provider.credentialProviderVendor as PaymentConnectorType | undefined;
    if (!arn || !vendor) {
      throw new AgentCoreCLIError(
        `payment credential provider "${reference}" returned no ARN or vendor`,
        { source: ERROR_SOURCE.SERVICE },
      );
    }
    if (type && type !== vendor) {
      throw new InputValidationError(
        `credential provider "${reference}" is a ${vendor} provider and cannot back a ${type} connector`,
      );
    }
    return { arn, type: vendor };
  }

  private async sendData<T>(
    managerId: string,
    options: CoreOptions,
    send: (data: BedrockAgentCoreClient, paymentManagerArn: string) => Promise<T>,
  ): Promise<T> {
    if (managerId.startsWith("arn:")) {
      throw new InputValidationError("use a payment manager ID, not an ARN");
    }
    const manager = await this.getPaymentManager(managerId, options);
    if (manager.authorizerType === "CUSTOM_JWT") {
      throw new InputValidationError(
        `payment manager "${managerId}" uses the CUSTOM_JWT authorizer, so its data plane accepts only bearer tokens; ` +
          "this CLI does not support bearer tokens for payment commands yet. " +
          "Use an AWS_IAM payment manager, or call the API directly with a JWT.",
      );
    }
    if (!manager.paymentManagerArn) {
      throw new MalformedServiceResponseError(`payment manager "${managerId}" returned no ARN`);
    }
    return send(this.clients.data(toClientConfig(options)), manager.paymentManagerArn);
  }
}

function credentialConfiguration(
  type: PaymentConnectorType,
  credentialProviderArn: string,
): CredentialsProviderConfiguration {
  return type === "CoinbaseCDP"
    ? { coinbaseCDP: { credentialProviderArn } }
    : { stripePrivy: { credentialProviderArn } };
}

// isServiceRoleUnusable widens the harness predicate: the payments control plane
// assumes the role during the create itself, so a not-yet-propagated role can
// also surface as an access-denied failure. Only an access denial that names the
// provisioned role counts; a caller's own permission denial also says
// "assumed-role/... is not authorized" and must surface immediately.
function isServiceRoleUnusable(roleArn: string): (error: Error) => boolean {
  const roleName = roleArn.split("/").pop() ?? roleArn;
  return (error) =>
    isRoleUnassumableValidation(error) ||
    (error.name === "AccessDeniedException" &&
      ((error.message ?? "").includes(roleArn) || (error.message ?? "").includes(roleName)));
}

// Connector creation and updates fail with SubscriptionRequiredException when the
// account has not subscribed to the provider's AWS Marketplace listing. The SDK
// error carries the listing URL and product name; surface both so the fix is one
// click away instead of a support search.
function subscriptionRequired(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== "SubscriptionRequiredException") return error;
  const { subscriptionUrl, productName } = error as Error & {
    subscriptionUrl?: string;
    productName?: string;
  };
  const product = productName ? ` to "${productName}"` : "";
  const where = subscriptionUrl ? ` Subscribe at ${subscriptionUrl}, then retry.` : "";
  return new AgentCoreCLIError(
    `${error.message} An active AWS Marketplace subscription${product} is required.${where}`,
    {
      cause: error,
      source: ERROR_SOURCE.USER,
      name: error.name,
      meta: { subscriptionUrl, productName },
    },
  );
}
