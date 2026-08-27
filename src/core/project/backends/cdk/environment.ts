import {
  DescribeStacksCommand,
  type CloudFormationClient,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { MalformedServiceResponseError, ProjectStateError } from "../../../../errors/errors";
import type { CreateCloudFormationClient } from "../../../types";
import type { CdkCredentialProvider } from "./toolkit";

const BOOTSTRAP_STACK_NAME = "CDKToolkit";
const BOOTSTRAP_VERSION_OUTPUT = "BootstrapVersion";
export const MINIMUM_BOOTSTRAP_VERSION = 30;

const STABLE_BOOTSTRAP_STATUSES = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
]);

export type BootstrapState =
  { kind: "absent" } | { kind: "current"; version: number } | { kind: "outdated"; version: number };

export type BootstrapStackReader = (
  region: string,
  credentials: CdkCredentialProvider,
) => Promise<Stack[] | undefined>;
export type BootstrapProbe = (
  region: string,
  credentials: CdkCredentialProvider,
) => Promise<BootstrapState>;
export type AccountResolver = (
  region: string,
  credentials: CdkCredentialProvider,
) => Promise<string>;
export type StackReader = (
  stackName: string,
  region: string,
  credentials: CdkCredentialProvider,
) => Promise<Stack[] | undefined>;
export type StackProbe = (
  stackName: string,
  region: string,
  credentials: CdkCredentialProvider,
) => Promise<boolean>;

/** Shares CloudFormation connections for calls using the same credentials and region. */
export function createCloudFormationStackReader(
  createClient: CreateCloudFormationClient,
): StackReader {
  const clients = new WeakMap<CdkCredentialProvider, Map<string, CloudFormationClient>>();

  return async (stackName, region, credentials) => {
    let clientsByRegion = clients.get(credentials);
    if (!clientsByRegion) {
      clientsByRegion = new Map();
      clients.set(credentials, clientsByRegion);
    }

    let client = clientsByRegion.get(region);
    if (!client) {
      client = createClient({ credentials, region });
      clientsByRegion.set(region, client);
    }

    const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    return response.Stacks;
  };
}

export function bootstrapStackReader(read: StackReader): BootstrapStackReader {
  return (region, credentials) => read(BOOTSTRAP_STACK_NAME, region, credentials);
}

export function readBootstrapState(stacks?: Stack[]): Exclude<BootstrapState, { kind: "absent" }> {
  const stack = stacks?.[0];
  if (!stack) {
    throw new MalformedServiceResponseError(
      `CloudFormation returned no stack after describing ${BOOTSTRAP_STACK_NAME}`,
    );
  }

  const status = stack.StackStatus;
  if (!status || !STABLE_BOOTSTRAP_STATUSES.has(status)) {
    throw new ProjectStateError(
      `The shared ${BOOTSTRAP_STACK_NAME} stack is in '${status ?? "UNKNOWN"}'. ` +
        `Resolve that stack manually before deploying this project.`,
    );
  }

  const rawVersion = stack.Outputs?.find(
    ({ OutputKey }) => OutputKey === BOOTSTRAP_VERSION_OUTPUT,
  )?.OutputValue;
  if (rawVersion !== undefined && !/^[0-9]+$/.test(rawVersion)) {
    throw new ProjectStateError(
      `The shared ${BOOTSTRAP_STACK_NAME} stack has an invalid ` +
        `${BOOTSTRAP_VERSION_OUTPUT} output: '${rawVersion}'.`,
    );
  }

  const version = rawVersion === undefined ? 0 : Number.parseInt(rawVersion, 10);
  return version >= MINIMUM_BOOTSTRAP_VERSION
    ? { kind: "current", version }
    : { kind: "outdated", version };
}

/** CloudFormation reports an absent stack as a ValidationError, not a typed one. */
export function isStackNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return (
    candidate.name === "ValidationError" &&
    typeof candidate.message === "string" &&
    /Stack with id .+ does not exist/i.test(candidate.message)
  );
}

export async function probeBootstrap(
  region: string,
  credentials: CdkCredentialProvider,
  read: BootstrapStackReader,
): Promise<BootstrapState> {
  try {
    return readBootstrapState(await read(region, credentials));
  } catch (error) {
    if (isStackNotFound(error)) return { kind: "absent" };
    throw error;
  }
}

/**
 * Whether CloudFormation still holds a stack of this name, so a deploy with
 * nothing left to deploy can tell "tear the stack down" from "there was never
 * anything here".
 *
 * Any stack CloudFormation returns counts as present, whatever its status: a
 * stack stuck mid-rollback is still a stack the user needs a way to remove.
 * Deleted stacks are not returned when looked up by name, only by id.
 */
export async function probeStack(
  stackName: string,
  region: string,
  credentials: CdkCredentialProvider,
  read: StackReader,
): Promise<boolean> {
  try {
    return ((await read(stackName, region, credentials)) ?? []).length > 0;
  } catch (error) {
    if (isStackNotFound(error)) return false;
    throw error;
  }
}

export const resolveAwsAccount: AccountResolver = async (region, credentials) => {
  const { GetCallerIdentityCommand, STSClient } = await import("@aws-sdk/client-sts");
  const client = new STSClient({ credentials, region });
  try {
    const { Account } = await client.send(new GetCallerIdentityCommand({}));
    if (!Account) {
      throw new MalformedServiceResponseError("STS GetCallerIdentity returned no AWS account ID");
    }
    return Account;
  } finally {
    client.destroy();
  }
};
