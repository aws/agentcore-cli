import type {
  CreatePaymentConnectorResponse,
  CreatePaymentManagerRequest,
  CreatePaymentManagerResponse,
  DeletePaymentConnectorRequest,
  DeletePaymentConnectorResponse,
  DeletePaymentManagerRequest,
  DeletePaymentManagerResponse,
  GetPaymentConnectorResponse,
  GetPaymentManagerResponse,
  ListPaymentConnectorsResponse,
  ListPaymentManagersResponse,
  PaymentConnectorType,
  UpdatePaymentConnectorRequest,
  UpdatePaymentConnectorResponse,
  UpdatePaymentManagerRequest,
  UpdatePaymentManagerResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
  CreatePaymentInstrumentRequest,
  CreatePaymentInstrumentResponse,
  CreatePaymentSessionRequest,
  CreatePaymentSessionResponse,
  DeletePaymentInstrumentRequest,
  DeletePaymentInstrumentResponse,
  DeletePaymentSessionRequest,
  DeletePaymentSessionResponse,
  GetPaymentInstrumentRequest,
  GetPaymentInstrumentResponse,
  GetPaymentInstrumentBalanceRequest,
  GetPaymentInstrumentBalanceResponse,
  GetPaymentSessionRequest,
  GetPaymentSessionResponse,
  ListPaymentInstrumentsRequest,
  ListPaymentInstrumentsResponse,
  ListPaymentSessionsRequest,
  ListPaymentSessionsResponse,
} from "@aws-sdk/client-bedrock-agentcore";
import type { CoreOptions } from "../../core/types";

// CreatePaymentManagerInput is CreatePaymentManagerRequest with the service role
// made optional: when omitted, Core provisions the default service role in IAM and
// creates the manager with it.
export type CreatePaymentManagerInput = Omit<CreatePaymentManagerRequest, "roleArn"> & {
  roleArn?: string;
};

export type UpdatePaymentManagerInput = UpdatePaymentManagerRequest;

// CreatePaymentConnectorInput names a credential provider instead of carrying the
// SDK's configuration list. Core resolves a provider name to its ARN and vendor
// through identity, derives the connector type from that vendor when the caller
// omits it, and builds the single-entry union the service expects. Quick Create
// sends no credentials; the service provisions them after OAuth consent.
export type CreatePaymentConnectorInput = {
  managerId: string;
  name: string;
  description?: string;
  type?: PaymentConnectorType;
  // A payment credential provider name or ARN. Required unless quickCreate is set.
  credentialProvider?: string;
  quickCreate?: boolean;
  clientToken?: string;
};

// UpdatePaymentConnectorInput omits `type`: the service rejects any change to a
// connector's type after creation, so the CLI does not offer it.
export type UpdatePaymentConnectorInput = {
  managerId: string;
  connectorId: string;
  description?: UpdatePaymentConnectorRequest["description"];
  credentialProvider?: string;
  clientToken?: string;
};

type WithPaymentManagerId<T> = Omit<T, "paymentManagerArn"> & { managerId: string };

export type CreatePaymentSessionInput = WithPaymentManagerId<CreatePaymentSessionRequest>;
export type GetPaymentSessionInput = WithPaymentManagerId<GetPaymentSessionRequest>;
export type ListPaymentSessionsInput = WithPaymentManagerId<ListPaymentSessionsRequest>;
export type DeletePaymentSessionInput = WithPaymentManagerId<DeletePaymentSessionRequest>;
export type CreatePaymentInstrumentInput = WithPaymentManagerId<CreatePaymentInstrumentRequest>;
export type GetPaymentInstrumentInput = WithPaymentManagerId<GetPaymentInstrumentRequest>;
export type GetPaymentInstrumentBalanceInput =
  WithPaymentManagerId<GetPaymentInstrumentBalanceRequest>;
export type ListPaymentInstrumentsInput = WithPaymentManagerId<ListPaymentInstrumentsRequest>;
export type DeletePaymentInstrumentInput = WithPaymentManagerId<DeletePaymentInstrumentRequest>;

export interface CorePaymentClient {
  createPaymentManager(
    input: CreatePaymentManagerInput,
    options: CoreOptions,
  ): Promise<CreatePaymentManagerResponse>;
  getPaymentManager(id: string, options: CoreOptions): Promise<GetPaymentManagerResponse>;
  listPaymentManagers(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListPaymentManagersResponse>;
  updatePaymentManager(
    input: UpdatePaymentManagerInput,
    options: CoreOptions,
  ): Promise<UpdatePaymentManagerResponse>;
  deletePaymentManager(
    request: DeletePaymentManagerRequest,
    options: CoreOptions,
  ): Promise<DeletePaymentManagerResponse>;

  createPaymentConnector(
    input: CreatePaymentConnectorInput,
    options: CoreOptions,
  ): Promise<CreatePaymentConnectorResponse>;
  getPaymentConnector(
    managerId: string,
    connectorId: string,
    options: CoreOptions,
  ): Promise<GetPaymentConnectorResponse>;
  listPaymentConnectors(
    managerId: string,
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListPaymentConnectorsResponse>;
  updatePaymentConnector(
    input: UpdatePaymentConnectorInput,
    options: CoreOptions,
  ): Promise<UpdatePaymentConnectorResponse>;
  deletePaymentConnector(
    request: DeletePaymentConnectorRequest,
    options: CoreOptions,
  ): Promise<DeletePaymentConnectorResponse>;

  // Core resolves the selected manager ID to the ARN required by the data plane.
  createPaymentSession(
    request: CreatePaymentSessionInput,
    options: CoreOptions,
  ): Promise<CreatePaymentSessionResponse>;
  getPaymentSession(
    request: GetPaymentSessionInput,
    options: CoreOptions,
  ): Promise<GetPaymentSessionResponse>;
  listPaymentSessions(
    request: ListPaymentSessionsInput,
    options: CoreOptions,
  ): Promise<ListPaymentSessionsResponse>;
  deletePaymentSession(
    request: DeletePaymentSessionInput,
    options: CoreOptions,
  ): Promise<DeletePaymentSessionResponse>;

  createPaymentInstrument(
    request: CreatePaymentInstrumentInput,
    options: CoreOptions,
  ): Promise<CreatePaymentInstrumentResponse>;
  getPaymentInstrument(
    request: GetPaymentInstrumentInput,
    options: CoreOptions,
  ): Promise<GetPaymentInstrumentResponse>;
  getPaymentInstrumentBalance(
    request: GetPaymentInstrumentBalanceInput,
    options: CoreOptions,
  ): Promise<GetPaymentInstrumentBalanceResponse>;
  listPaymentInstruments(
    request: ListPaymentInstrumentsInput,
    options: CoreOptions,
  ): Promise<ListPaymentInstrumentsResponse>;
  deletePaymentInstrument(
    request: DeletePaymentInstrumentInput,
    options: CoreOptions,
  ): Promise<DeletePaymentInstrumentResponse>;
}
