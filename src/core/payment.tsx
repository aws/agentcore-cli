import {
  GetPaymentConnectorCommand,
  GetPaymentManagerCommand,
  ListPaymentConnectorsCommand,
  ListPaymentManagersCommand,
  type GetPaymentConnectorResponse,
  type GetPaymentManagerResponse,
  type ListPaymentConnectorsResponse,
  type ListPaymentManagersResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  GetPaymentInstrumentBalanceCommand,
  GetPaymentInstrumentCommand,
  GetPaymentSessionCommand,
  ListPaymentInstrumentsCommand,
  ListPaymentSessionsCommand,
  type BedrockAgentCoreClient,
  type GetPaymentInstrumentResponse,
  type GetPaymentInstrumentBalanceResponse,
  type GetPaymentSessionResponse,
  type ListPaymentInstrumentsResponse,
  type ListPaymentSessionsResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import { InputValidationError, MalformedServiceResponseError } from "../errors";
import type {
  CorePaymentClient,
  GetPaymentSessionInput,
  ListPaymentSessionsInput,
  GetPaymentInstrumentInput,
  GetPaymentInstrumentBalanceInput,
  ListPaymentInstrumentsInput,
} from "../handlers/payment/types";
import type { AwsClients, CoreOptions } from "./types";
import { toClientConfig } from "./utils";

// PaymentClient implements the payment-facing operations on top of the shared
// AWS clients provided by CoreClient. Managers and connectors live on the control
// plane; sessions and instruments on the data plane.
export class PaymentClient implements CorePaymentClient {
  constructor(private readonly clients: Pick<AwsClients, "control" | "data">) {}

  // ─── payment managers ───────────────────────────────────────────────────────

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

  // ─── payment connectors ─────────────────────────────────────────────────────

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

  // ─── payment sessions (data plane) ──────────────────────────────────────────

  async getPaymentSession(
    input: GetPaymentSessionInput,
    options: CoreOptions,
  ): Promise<GetPaymentSessionResponse> {
    const { managerId, ...request } = input;
    return this.withPaymentManagerArn(managerId, options, (data, paymentManagerArn) =>
      data.send(new GetPaymentSessionCommand({ paymentManagerArn, ...request })),
    );
  }

  async listPaymentSessions(
    input: ListPaymentSessionsInput,
    options: CoreOptions,
  ): Promise<ListPaymentSessionsResponse> {
    const { managerId, ...request } = input;
    return this.withPaymentManagerArn(managerId, options, (data, paymentManagerArn) =>
      data.send(new ListPaymentSessionsCommand({ paymentManagerArn, ...request })),
    );
  }

  // ─── payment instruments (data plane) ───────────────────────────────────────

  async getPaymentInstrument(
    input: GetPaymentInstrumentInput,
    options: CoreOptions,
  ): Promise<GetPaymentInstrumentResponse> {
    const { managerId, ...request } = input;
    return this.withPaymentManagerArn(managerId, options, (data, paymentManagerArn) =>
      data.send(new GetPaymentInstrumentCommand({ paymentManagerArn, ...request })),
    );
  }

  async getPaymentInstrumentBalance(
    input: GetPaymentInstrumentBalanceInput,
    options: CoreOptions,
  ): Promise<GetPaymentInstrumentBalanceResponse> {
    const { managerId, ...request } = input;
    return this.withPaymentManagerArn(managerId, options, (data, paymentManagerArn) =>
      data.send(new GetPaymentInstrumentBalanceCommand({ paymentManagerArn, ...request })),
    );
  }

  async listPaymentInstruments(
    input: ListPaymentInstrumentsInput,
    options: CoreOptions,
  ): Promise<ListPaymentInstrumentsResponse> {
    const { managerId, ...request } = input;
    return this.withPaymentManagerArn(managerId, options, (data, paymentManagerArn) =>
      data.send(new ListPaymentInstrumentsCommand({ paymentManagerArn, ...request })),
    );
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  private async withPaymentManagerArn<T>(
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
