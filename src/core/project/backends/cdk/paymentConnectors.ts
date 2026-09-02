import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import type { CdkCredentialProvider } from "./toolkit";

/** How long the service leaves a Quick Create authorization link usable. */
const AUTHORIZATION_WINDOW = "10 minutes";

/** The one status that means a link exists for someone to use. */
const PENDING = "PENDING_AUTHENTICATION";

export type PaymentConnectorCalls = {
  /**
   * The payment managers in *this project's* stack.
   *
   * Scoped through the stack rather than by matching manager names against the
   * account, because manager names are account-scoped: two projects both
   * declaring `payments` would otherwise be indistinguishable.
   */
  listStackManagerIds: (input: Target & { stackName: string }) => Promise<string[]>;
  /** The manager's service-side name, which pairs it with the project spec. */
  getManagerName: (input: Target & { managerId: string }) => Promise<string | undefined>;
  /** The manager's connectors. Scoped to the manager, so names cannot collide. */
  listConnectors: (
    input: Target & { managerId: string },
  ) => Promise<{ name?: string; paymentConnectorId?: string; status?: string }[]>;
  /**
   * The live authorization URL. Deliberately not read from the stack output of
   * the same name: that output is an `Fn::GetAtt` resolved when the connector was
   * created, so it keeps serving a dead link — and a stale `PENDING` status —
   * after the window closes.
   */
  getAuthorizationUrl: (
    input: Target & { managerId: string; connectorId: string },
  ) => Promise<string | undefined>;
};

type Target = { region: string; credentials: CdkCredentialProvider };

export type QuickCreateAuthorizationReporter = (
  project: Project,
  input: Target & { stackName: string },
) => AsyncGenerator<ProjectEvent, void>;

/**
 * Reports the Quick Create connectors a deploy left needing authorization.
 *
 * Quick Create is inherently two-phase: CloudFormation creates the connector
 * pending, someone completes the provider's flow out of band, and only then is it
 * usable. The link expires about ten minutes after the connector is created, so a
 * deploy that says nothing leaves the project looking successful while the
 * connector is unusable — and by the time anyone thinks to look, the window is
 * gone.
 *
 * Reads run after a successful deploy and never fail it: the stack is already up,
 * so an unreadable status is reported and the deploy still succeeds.
 */
export function createQuickCreateAuthorizationReporter(
  calls: PaymentConnectorCalls,
): QuickCreateAuthorizationReporter {
  return async function* reportQuickCreateAuthorizations(project, { stackName, ...target }) {
    // Every project without Quick Create pays nothing: no calls are made.
    if (!declaresQuickCreate(project)) return;

    let managerIds: string[];
    try {
      managerIds = await calls.listStackManagerIds({ ...target, stackName });
    } catch (error) {
      yield unreadable("payment connectors", error);
      return;
    }

    for (const managerId of managerIds) {
      try {
        yield* reportManager(calls, project, target, managerId);
      } catch (error) {
        yield unreadable(`payment connectors on manager '${managerId}'`, error);
      }
    }
  };
}

async function* reportManager(
  calls: PaymentConnectorCalls,
  project: Project,
  target: Target,
  managerId: string,
): AsyncGenerator<ProjectEvent, void> {
  const managerName = await calls.getManagerName({ ...target, managerId });
  if (!managerName) return;

  // Pair the deployed manager with the spec by name so the expected connectors
  // are the ones this project declared, not whatever else the manager holds.
  const declared = project.spec.payments?.find((manager) => manager.name === managerName);
  const quickCreateNames = new Set(
    (declared?.connectors ?? [])
      .filter((connector) => connector.provisionMode === "QUICK_CREATE")
      .map((connector) => connector.name),
  );
  if (quickCreateNames.size === 0) return;

  for (const connector of await calls.listConnectors({ ...target, managerId })) {
    if (!connector.name || !quickCreateNames.has(connector.name)) continue;

    const label = `${managerName}/${connector.name}`;
    // Only a pending connector has a link to hand over; asking for one in any
    // other state returns nothing and would read as a failure.
    const url =
      connector.status === PENDING && connector.paymentConnectorId
        ? await calls.getAuthorizationUrl({
            ...target,
            managerId,
            connectorId: connector.paymentConnectorId,
          })
        : undefined;

    yield { type: "step", message: describe(label, connector.status, url) };
  }
}

function declaresQuickCreate(project: Project): boolean {
  return (project.spec.payments ?? []).some((manager) =>
    manager.connectors.some((connector) => connector.provisionMode === "QUICK_CREATE"),
  );
}

function unreadable(subject: string, error: unknown): ProjectEvent {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    type: "step",
    message: `Deployed, but the live status of ${subject} could not be retrieved: ${detail}`,
  };
}

/** The line a user acts on. Wording follows the released CLI. */
function describe(label: string, status: string | undefined, url: string | undefined): string {
  if (status === PENDING && url) {
    return (
      `Authorize payment connector "${label}": ${url}\n` +
      `This link expires ${AUTHORIZATION_WINDOW} after the connector is created.`
    );
  }
  if (status === PENDING) {
    return `Payment connector "${label}" is pending authorization, but no authorization URL was returned.`;
  }
  if (status === "READY") {
    return `Payment connector "${label}" is ready.`;
  }
  if (status === "AUTHENTICATION_EXPIRED" || status === "AUTHENTICATION_FAILED") {
    return (
      `Payment connector "${label}" is ${status}. Remove and deploy it, then add and ` +
      `deploy it again to generate a new authorization URL.`
    );
  }
  return `Payment connector "${label}" status: ${status ?? "unknown"}.`;
}
