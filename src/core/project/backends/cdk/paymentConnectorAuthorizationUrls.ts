import {
  GetPaymentConnectorCommand,
  type GetPaymentConnectorCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import { createCloudFormationClient, createControlClient } from "../../../factories";
import type { CreateCloudFormationClient, CreateControlClient } from "../../../types";
import type { CdkCredentialProvider } from "./toolkit";

const PAYMENT_CONNECTOR_RESOURCE_TYPE = "AWS::BedrockAgentCore::PaymentConnector";
const PAYMENT_CONNECTOR_ARN = /:payment-manager\/([^/]+)\/connector\/([^/]+)$/;

type Target = { region: string; credentials: CdkCredentialProvider };

export type PaymentConnectorAuthorizationUrlReporter = (
  project: Project,
  input: Target & { stackName: string },
) => AsyncGenerator<ProjectEvent, void>;

/**
 * Prints each live Quick Create authorization URL after a successful deployment.
 *
 * CloudFormation scopes discovery to this project's stack. The connector's physical
 * ARN contains both IDs required by GetPaymentConnector, which returns the URL only
 * while one is available.
 */
export function createPaymentConnectorAuthorizationUrlReporter(
  createStackClient: CreateCloudFormationClient = createCloudFormationClient,
  createPaymentsClient: CreateControlClient = createControlClient,
): PaymentConnectorAuthorizationUrlReporter {
  return async function* reportPaymentConnectorAuthorizationUrls(
    project,
    { stackName, region, credentials },
  ) {
    if (!declaresQuickCreate(project)) return;

    const stackClient = createStackClient({ credentials, region });
    const paymentsClient = createPaymentsClient({ credentials, region });

    try {
      let token: string | undefined;
      do {
        const page = await stackClient.send(
          new ListStackResourcesCommand({ StackName: stackName, NextToken: token }),
        );
        for (const resource of page.StackResourceSummaries ?? []) {
          if (
            resource.ResourceType !== PAYMENT_CONNECTOR_RESOURCE_TYPE ||
            !resource.PhysicalResourceId
          ) {
            continue;
          }

          const ids = paymentConnectorIds(resource.PhysicalResourceId);
          if (!ids) continue;

          let connector: GetPaymentConnectorCommandOutput;
          try {
            connector = await paymentsClient.send(
              new GetPaymentConnectorCommand({
                paymentManagerId: ids.managerId,
                paymentConnectorId: ids.connectorId,
              }),
            );
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            yield {
              type: "step",
              message:
                `Deployed, but payment connector '${ids.connectorId}' authorization URL ` +
                `could not be retrieved: ${detail}`,
            };
            continue;
          }
          if (!connector.authorizationUrl) continue;

          yield {
            type: "step",
            message: `Authorize payment connector "${connector.name ?? ids.connectorId}": ${connector.authorizationUrl}`,
          };
        }
        token = page.NextToken;
      } while (token);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      yield {
        type: "step",
        message: `Deployed, but payment connector authorization URLs could not be retrieved: ${detail}`,
      };
    }
  };
}

function paymentConnectorIds(
  physicalResourceId: string,
): { managerId: string; connectorId: string } | undefined {
  const match = PAYMENT_CONNECTOR_ARN.exec(physicalResourceId);
  const managerId = match?.[1];
  const connectorId = match?.[2];
  return managerId && connectorId ? { managerId, connectorId } : undefined;
}

function declaresQuickCreate(project: Project): boolean {
  return (project.spec.payments ?? []).some((manager) =>
    manager.connectors.some((connector) => connector.provisionMode === "QUICK_CREATE"),
  );
}
