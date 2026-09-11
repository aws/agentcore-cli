import type {
  GetPaymentConnectorResponse,
  GetPaymentManagerResponse,
  ListPaymentConnectorsResponse,
  ListPaymentManagersResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type {
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

type WithPaymentManagerId<T> = Omit<T, "paymentManagerArn"> & { managerId: string };

export type GetPaymentSessionInput = WithPaymentManagerId<GetPaymentSessionRequest>;
export type ListPaymentSessionsInput = WithPaymentManagerId<ListPaymentSessionsRequest>;
export type GetPaymentInstrumentInput = WithPaymentManagerId<GetPaymentInstrumentRequest>;
export type GetPaymentInstrumentBalanceInput =
  WithPaymentManagerId<GetPaymentInstrumentBalanceRequest>;
export type ListPaymentInstrumentsInput = WithPaymentManagerId<ListPaymentInstrumentsRequest>;

export interface CorePaymentClient {
  getPaymentManager(id: string, options: CoreOptions): Promise<GetPaymentManagerResponse>;
  listPaymentManagers(
    nextToken: string | undefined,
    maxResults: number | undefined,
    options: CoreOptions,
  ): Promise<ListPaymentManagersResponse>;
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

  // Core resolves the selected manager ID to the ARN required by the data plane.
  getPaymentSession(
    request: GetPaymentSessionInput,
    options: CoreOptions,
  ): Promise<GetPaymentSessionResponse>;
  listPaymentSessions(
    request: ListPaymentSessionsInput,
    options: CoreOptions,
  ): Promise<ListPaymentSessionsResponse>;
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
}
