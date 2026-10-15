import {
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  type Change,
  type CloudFormationClient,
  type DescribeChangeSetCommandOutput,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { isClientError, poll, StackRefactorError, type PollOptions } from "./refactor";
import {
  CDK_METADATA_TYPE,
  referencesIn,
  resourcesOf,
  type CfnResource,
  type CfnTemplate,
} from "./templates";
import { templateLocation, type TemplateStore } from "./templateStore";

/**
 * Deployed resource types migrate deliberately leaves out of the v1 project.
 * Without retain policies, the first v1 deploy would delete them, so migrate
 * sets the policies before the refactor and leaves them in AWS outside the stack.
 */
export const RETAINABLE_TYPES: ReadonlySet<string> = new Set([
  "AWS::Bedrock::KnowledgeBase",
  "AWS::BedrockAgentCore::Dataset",
  "AWS::BedrockAgentCore::OnlineEvaluationConfig",
]);

/** How a retained resource of each type is looked after once v1 no longer manages it. */
export const RETAINED_GUIDANCE: Readonly<Record<string, string>> = {
  "AWS::Bedrock::KnowledgeBase":
    "manage it with the AWS Bedrock knowledge base APIs or AWS CLI, using its ID",
  "AWS::BedrockAgentCore::Dataset":
    "manage it with the `agentcore eval dataset` commands, using its ID",
  "AWS::BedrockAgentCore::OnlineEvaluationConfig":
    "manage it with the `agentcore eval online-eval` commands, using its ID",
};

/** A deployed resource the migration keeps in the account outside the stack. */
export type RetainedResource = {
  logicalId: string;
  type: string;
  /** Whether the deployed template already retains it, so no update is needed for it. */
  alreadyRetained: boolean;
};

const RETAIN = "Retain";

function retains(resource: CfnResource): boolean {
  return resource.DeletionPolicy === RETAIN && resource.UpdateReplacePolicy === RETAIN;
}

/**
 * The resources a migration has to retain: every deployed resource of a
 * retainable type that the v1 template drops, and the whole connected component
 * of dropped resources around it. Walking both what a retained resource
 * references and what references it preserves supporting resources such as an
 * IAM policy attached to a knowledge base's service role. Resources v1 keeps
 * under some logical ID are left alone: they stay managed.
 */
export function resourcesToRetain(
  deployed: CfnTemplate,
  droppedByV1: ReadonlySet<string>,
): RetainedResource[] {
  const resources = resourcesOf(deployed);
  const dropped = new Set(
    [...droppedByV1].filter(
      (id) => resources[id] !== undefined && resources[id]?.Type !== CDK_METADATA_TYPE,
    ),
  );
  const adjacent = new Map<string, Set<string>>([...dropped].map((id) => [id, new Set()]));
  const isResource = (id: string) => id in resources;
  for (const id of dropped) {
    const resource = resources[id]!;
    const references = [
      ...referencesIn(resource.Properties, isResource).map((reference) => reference.target),
      ...[resource.DependsOn ?? []].flat(),
    ];
    for (const target of references) {
      if (!dropped.has(target)) continue;
      adjacent.get(id)!.add(target);
      adjacent.get(target)!.add(id);
    }
  }

  const seeds = [...dropped].filter((id) => RETAINABLE_TYPES.has(resources[id]!.Type));
  const keep = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (keep.has(id)) continue;
    keep.add(id);
    queue.push(...(adjacent.get(id) ?? []));
  }
  return [...keep].sort().map((logicalId) => ({
    logicalId,
    type: resources[logicalId]!.Type,
    alreadyRetained: retains(resources[logicalId]!),
  }));
}

/** The template with DeletionPolicy and UpdateReplacePolicy Retain on the given resources. */
export function withRetain(template: CfnTemplate, logicalIds: Iterable<string>): CfnTemplate {
  const copy = structuredClone(template);
  const resources = resourcesOf(copy);
  for (const id of logicalIds) {
    const resource = resources[id];
    if (!resource) throw new Error(`Resource '${id}' isn't in the template.`);
    resource.DeletionPolicy = RETAIN;
    resource.UpdateReplacePolicy = RETAIN;
  }
  return copy;
}

const POLICY_ATTRIBUTES = new Set(["DeletionPolicy", "UpdateReplacePolicy"]);

/**
 * How a change set differs from setting only the retain policies on `expected`;
 * undefined when it doesn't. Anything else (a property change, another resource)
 * means the deployed template wasn't what the plan read.
 */
export function retainChangesMismatch(
  changes: Change[],
  expected: ReadonlySet<string>,
): string | undefined {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    const resource = change.ResourceChange;
    const id = resource?.LogicalResourceId ?? "<unknown>";
    if (change.Type !== "Resource" || resource?.Action !== "Modify" || !expected.has(id)) {
      problems.push(`unexpected ${resource?.Action ?? change.Type ?? "change"} of ${id}`);
      continue;
    }
    if (resource.Replacement && resource.Replacement !== "False") {
      problems.push(`${id} would be replaced`);
    }
    for (const detail of resource.Details ?? []) {
      const target = detail.Target;
      if (target?.Attribute !== undefined && !POLICY_ATTRIBUTES.has(target.Attribute)) {
        problems.push(`${id} changes ${target.Attribute}${target.Name ? ` ${target.Name}` : ""}`);
      }
    }
    seen.add(id);
  }
  for (const id of expected) if (!seen.has(id)) problems.push(`no change to ${id}`);
  return problems.length > 0 ? problems.join(", ") : undefined;
}

/** One deployed stack whose unsupported resources to retain before its refactor. */
export type RetainStack = {
  stackName: string;
  region: string;
  /** The deployed template with the retain policies set: what the update moves the stack to. */
  template: CfnTemplate;
  /** The resources the update sets the policies on. */
  logicalIds: ReadonlySet<string>;
  client: CloudFormationClient;
  templates: () => Promise<TemplateStore>;
};

/** A change set name unique to this run, so a rerun never trips over an old one. */
export function retainChangeSetName(now: Date = new Date()): string {
  return `agentcore-migrate-retain-${now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}`;
}

/**
 * Sets DeletionPolicy and UpdateReplacePolicy Retain on the stack's unsupported
 * resources with a change set that changes nothing else: the change set's
 * changes are checked to be exactly those attributes on exactly those resources
 * before it's executed, and deleted otherwise. A change set CloudFormation
 * refused, or that rolled back, leaves the stack as it was; one whose outcome
 * couldn't be read is `unknown`, and must be checked before anything else.
 */
export async function retainResources(
  stack: RetainStack,
  options: PollOptions & {
    changeSetName?: string;
    onCreated?: (name: string) => Promise<void>;
  } = {},
): Promise<void> {
  const { client, stackName, region } = stack;
  const changeSetName = options.changeSetName ?? retainChangeSetName();
  const details = { stackName, region };
  const createdDetails = { ...details, refactorId: changeSetName };
  const deployed = await describeStack(client, stackName);
  const template = await templateLocation(stack.template, `${stackName}-retain`, stack.templates);
  try {
    options.onStep?.(`Retaining the unsupported resources of stack ${stackName}`);
    try {
      await client.send(
        new CreateChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
          ChangeSetType: "UPDATE",
          Description: "agentcore migrate: retain resources v1 doesn't manage",
          ...template.location,
          Parameters: (deployed.Parameters ?? []).map((parameter) => ({
            ParameterKey: parameter.ParameterKey,
            UsePreviousValue: true,
          })),
          Capabilities: deployed.Capabilities ?? [],
        }),
      );
    } catch (error) {
      throw new StackRefactorError(
        `Couldn't create the change set that retains resources in stack '${stackName}': ` +
          `${(error as Error).message}. Nothing was changed.`,
        { kind: "create-failed", ...details },
      );
    }
    await options.onCreated?.(changeSetName);
    const created = await poll(
      () => describeChangeSet(client, stackName, changeSetName),
      (state) => !state.Status?.endsWith("_PENDING") && !state.Status?.endsWith("_IN_PROGRESS"),
      options,
    );
    if (created.Status !== "CREATE_COMPLETE") {
      await deleteRetainChangeSet(client, stackName, changeSetName);
      throw new StackRefactorError(
        `CloudFormation couldn't prepare the change set that retains resources in stack ` +
          `'${stackName}' (${created.Status ?? "UNKNOWN"}): ${created.StatusReason ?? "no reason given"}. ` +
          "Nothing was changed.",
        { kind: "create-failed", ...createdDetails },
      );
    }
    const mismatch = retainChangesMismatch(created.Changes ?? [], stack.logicalIds);
    if (mismatch) {
      await deleteRetainChangeSet(client, stackName, changeSetName);
      throw new StackRefactorError(
        `The change set that retains resources in stack '${stackName}' would do more than set ` +
          `their retain policies (${mismatch}), so it was deleted unexecuted. Nothing was changed.`,
        { kind: "create-failed", ...createdDetails },
      );
    }
    try {
      await client.send(
        new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }),
      );
    } catch (error) {
      // Only CloudFormation's own refusal proves the change set didn't start.
      if (isClientError(error)) {
        await deleteRetainChangeSet(client, stackName, changeSetName);
        throw new StackRefactorError(
          `CloudFormation refused to execute the change set that retains resources in stack ` +
            `'${stackName}': ${(error as Error).message}. Nothing was changed.`,
          { kind: "execute-failed", ...createdDetails },
        );
      }
      throw unknownOutcome(stackName, region, changeSetName, (error as Error).message);
    }
    let finished: Stack;
    try {
      finished = await poll(
        () => describeStack(client, stackName),
        (state) => !state.StackStatus?.endsWith("_IN_PROGRESS"),
        options,
      );
    } catch (error) {
      throw unknownOutcome(stackName, region, changeSetName, (error as Error).message);
    }
    if (finished.StackStatus !== "UPDATE_COMPLETE") {
      const kind =
        finished.StackStatus === "UPDATE_ROLLBACK_COMPLETE" ? "execute-failed" : "unknown";
      throw new StackRefactorError(
        `The update that retains resources in stack '${stackName}' ended ${finished.StackStatus ?? "UNKNOWN"}` +
          (kind === "execute-failed" ? " and rolled back, so the stack is unchanged." : "."),
        { kind, ...createdDetails, ...(finished.StackStatus && { status: finished.StackStatus }) },
      );
    }
    const missing = await notRetained(client, stackName, stack.logicalIds);
    if (missing.length > 0) {
      throw unknownOutcome(
        stackName,
        region,
        changeSetName,
        `the update finished, but the deployed template doesn't retain ${missing.join(", ")}`,
      );
    }
    await deleteRetainChangeSet(client, stackName, changeSetName);
  } finally {
    await template.release();
  }
}

function unknownOutcome(
  stackName: string,
  region: string,
  changeSetName: string,
  detail: string,
): StackRefactorError {
  return new StackRefactorError(
    `Lost track of the update that retains resources in stack '${stackName}' (${detail}), so ` +
      "whether it finished isn't known.",
    { kind: "unknown", stackName, region, refactorId: changeSetName },
  );
}

async function describeStack(client: CloudFormationClient, stackName: string): Promise<Stack> {
  const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = response.Stacks?.[0];
  if (!stack) throw new Error(`CloudFormation returned no stack named '${stackName}'.`);
  return stack;
}

async function describeChangeSet(
  client: CloudFormationClient,
  stackName: string,
  changeSetName: string,
): Promise<DescribeChangeSetCommandOutput> {
  const first = await client.send(
    new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }),
  );
  const changes = [...(first.Changes ?? [])];
  let token = first.NextToken;
  while (token) {
    const page = await client.send(
      new DescribeChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        NextToken: token,
      }),
    );
    changes.push(...(page.Changes ?? []));
    token = page.NextToken;
  }
  return { ...first, Changes: changes };
}

export async function deleteRetainChangeSet(
  client: CloudFormationClient,
  stackName: string,
  changeSetName: string,
): Promise<void> {
  try {
    await client.send(
      new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }),
    );
  } catch {
    // Cleanup is best effort: leaving any change set behind is only clutter.
  }
}

/** The given resources the deployed template doesn't retain. */
async function notRetained(
  client: CloudFormationClient,
  stackName: string,
  logicalIds: ReadonlySet<string>,
): Promise<string[]> {
  const response = await client.send(
    new GetTemplateCommand({ StackName: stackName, TemplateStage: "Original" }),
  );
  const body = response.TemplateBody;
  const template = (typeof body === "string" ? JSON.parse(body) : body) as CfnTemplate;
  const resources = resourcesOf(template);
  return [...logicalIds].filter((id) => !resources[id] || !retains(resources[id]!));
}

/** The commands that show whether a retain update finished. */
export function retainCheckCommands(
  stackName: string,
  region: string,
  changeSetName: string,
): string[] {
  return [
    `aws cloudformation describe-change-set --stack-name ${stackName} --change-set-name ${changeSetName} --region ${region}`,
    `aws cloudformation describe-stacks --stack-name ${stackName} --region ${region}`,
  ];
}
