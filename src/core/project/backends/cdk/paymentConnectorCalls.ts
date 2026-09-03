import {
  GetPaymentConnectorCommand,
  GetPaymentManagerCommand,
  ListPaymentConnectorsCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { createCloudFormationClient, createControlClient } from "../../../factories";
import type { CreateCloudFormationClient, CreateControlClient } from "../../../types";
import type { PaymentConnectorCalls } from "./paymentConnectors";

const PAYMENT_MANAGER_RESOURCE_TYPE = "AWS::BedrockAgentCore::PaymentManager";

/**
 * The manager ID the Payments API takes, from the physical resource ID
 * CloudFormation reports.
 *
 * CloudFormation reports the manager's ARN, while `paymentManagerId` accepts only
 * the bare identifier and rejects an ARN outright. Anything without a slash is
 * already an ID and passes through, so this keeps working if the resource ever
 * reports one directly.
 */
export function paymentManagerId(physicalResourceId: string): string {
  return physicalResourceId.slice(physicalResourceId.lastIndexOf("/") + 1);
}

/**
 * The AWS reads behind the Quick Create authorization report, kept apart from the
 * reporting logic so that logic tests without the SDK — the split `stackReader`
 * uses for the same reason.
 *
 * Clients are created per call rather than cached: these reads happen once at the
 * end of a deploy, so a shared connection buys nothing.
 */
export function createPaymentConnectorCalls(
  createStackClient: CreateCloudFormationClient = createCloudFormationClient,
  createPaymentsClient: CreateControlClient = createControlClient,
): PaymentConnectorCalls {
  return {
    async listStackManagerIds({ stackName, region, credentials }) {
      const client = createStackClient({ credentials, region });
      const ids: string[] = [];
      let token: string | undefined;
      // Paginated because a project may declare more managers than one page holds.
      do {
        const page = await client.send(
          new ListStackResourcesCommand({ StackName: stackName, NextToken: token }),
        );
        for (const resource of page.StackResourceSummaries ?? []) {
          if (
            resource.ResourceType === PAYMENT_MANAGER_RESOURCE_TYPE &&
            resource.PhysicalResourceId
          ) {
            ids.push(paymentManagerId(resource.PhysicalResourceId));
          }
        }
        token = page.NextToken;
      } while (token);
      return ids;
    },

    async getManagerName({ managerId, region, credentials }) {
      const response = await createPaymentsClient({ credentials, region }).send(
        new GetPaymentManagerCommand({ paymentManagerId: managerId }),
      );
      return response.name;
    },

    async listConnectors({ managerId, region, credentials }) {
      const client = createPaymentsClient({ credentials, region });
      const connectors: { name?: string; paymentConnectorId?: string; status?: string }[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListPaymentConnectorsCommand({ paymentManagerId: managerId, nextToken: token }),
        );
        for (const summary of page.paymentConnectors ?? []) {
          connectors.push({
            name: summary.name,
            paymentConnectorId: summary.paymentConnectorId,
            status: summary.status,
          });
        }
        token = page.nextToken;
      } while (token);
      return connectors;
    },

    async getAuthorizationUrl({ managerId, connectorId, region, credentials }) {
      const response = await createPaymentsClient({ credentials, region }).send(
        new GetPaymentConnectorCommand({
          paymentManagerId: managerId,
          paymentConnectorId: connectorId,
        }),
      );
      return response.authorizationUrl;
    },
  };
}
