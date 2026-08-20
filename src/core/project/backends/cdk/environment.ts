import type { Stack } from "@aws-sdk/client-cloudformation";
import { MalformedServiceResponseError, ProjectStateError } from "../../../../errors/errors";

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

export type BootstrapStackReader = (region: string) => Promise<Stack[] | undefined>;
export type BootstrapProbe = (region: string) => Promise<BootstrapState>;
export type AccountResolver = (region: string) => Promise<string>;

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

export function isBootstrapStackNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return (
    candidate.name === "ValidationError" &&
    typeof candidate.message === "string" &&
    /Stack with id .+ does not exist/i.test(candidate.message)
  );
}

const describeBootstrapStack: BootstrapStackReader = async (region) => {
  const { CloudFormationClient, DescribeStacksCommand } =
    await import("@aws-sdk/client-cloudformation");
  const client = new CloudFormationClient({ region });
  try {
    const response = await client.send(
      new DescribeStacksCommand({ StackName: BOOTSTRAP_STACK_NAME }),
    );
    return response.Stacks;
  } finally {
    client.destroy();
  }
};

export async function probeBootstrap(
  region: string,
  read: BootstrapStackReader = describeBootstrapStack,
): Promise<BootstrapState> {
  try {
    return readBootstrapState(await read(region));
  } catch (error) {
    if (isBootstrapStackNotFound(error)) return { kind: "absent" };
    throw error;
  }
}

export const resolveAwsAccount: AccountResolver = async (region) => {
  const { GetCallerIdentityCommand, STSClient } = await import("@aws-sdk/client-sts");
  const client = new STSClient({ region });
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
