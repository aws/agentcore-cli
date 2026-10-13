import {
  GetRoleCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  ListRoleTagsCommand,
} from "@aws-sdk/client-iam";
import type {
  CoreExecutionRoleSourceReader,
  ExecutionRoleSource,
} from "../handlers/project/export/types";
import { InputValidationError, MalformedServiceResponseError } from "../errors";
import type { AwsClients, CoreOptions } from "./types";

export class ExecutionRoleSourceReader implements CoreExecutionRoleSourceReader {
  constructor(private readonly clients: Pick<AwsClients, "iam">) {}

  async read(roleArn: string, options: CoreOptions): Promise<ExecutionRoleSource> {
    const match = /^arn:[^:]+:iam::\d{12}:role\/(?:[^/]+\/)*([^/]+)$/.exec(roleArn);
    if (!match?.[1]) throw new InputValidationError(`Invalid execution role ARN: ${roleArn}`);
    // AgentCore endpoint overrides do not apply to IAM.
    const iam = this.clients.iam({ region: options.region, credentials: options.credentials });
    const RoleName = match[1];
    const { Role } = await iam.send(new GetRoleCommand({ RoleName }));
    if (Role?.Arn !== roleArn) this.incomplete(roleArn, "GetRole");
    const boundary = Role.PermissionsBoundary;
    if (boundary && !boundary.PermissionsBoundaryArn)
      this.incomplete(roleArn, "permissions boundary");
    const source: ExecutionRoleSource = {
      roleArn,
      inlinePolicies: [],
      managedPolicyArns: [],
      tags: {},
      ...(boundary && { permissionsBoundaryArn: boundary.PermissionsBoundaryArn }),
    };
    let Marker: string | undefined;
    do {
      const page = await iam.send(new ListRolePoliciesCommand({ RoleName, Marker }));
      if (!page.PolicyNames) this.incomplete(roleArn, "ListRolePolicies");
      for (const name of page.PolicyNames) {
        if (!name) this.incomplete(roleArn, "ListRolePolicies");
        const policy = await iam.send(new GetRolePolicyCommand({ RoleName, PolicyName: name }));
        source.inlinePolicies.push({
          name,
          document: this.policyDocument(policy.PolicyDocument, roleArn, name),
        });
      }
      Marker = this.nextMarker(page, Marker, roleArn);
    } while (Marker);
    do {
      const page = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName, Marker }));
      if (!page.AttachedPolicies) this.incomplete(roleArn, "ListAttachedRolePolicies");
      for (const policy of page.AttachedPolicies) {
        if (!policy.PolicyArn) this.incomplete(roleArn, "ListAttachedRolePolicies");
        source.managedPolicyArns.push(policy.PolicyArn);
      }
      Marker = this.nextMarker(page, Marker, roleArn);
    } while (Marker);
    do {
      const page = await iam.send(new ListRoleTagsCommand({ RoleName, Marker }));
      if (!page.Tags) this.incomplete(roleArn, "ListRoleTags");
      for (const tag of page.Tags) {
        if (!tag.Key || tag.Value === undefined) this.incomplete(roleArn, "ListRoleTags");
        if (!tag.Key.toLowerCase().startsWith("aws:")) {
          source.tags[tag.Key] = tag.Value;
        }
      }
      Marker = this.nextMarker(page, Marker, roleArn);
    } while (Marker);
    return source;
  }

  private nextMarker(
    page: { IsTruncated?: boolean; Marker?: string },
    previous: string | undefined,
    roleArn: string,
  ): string | undefined {
    if (typeof page.IsTruncated !== "boolean") this.incomplete(roleArn, "IAM pagination");
    if (!page.IsTruncated) return undefined;
    if (!page.Marker || page.Marker === previous) this.incomplete(roleArn, "IAM pagination");
    return page.Marker;
  }

  private policyDocument(
    raw: string | undefined,
    roleArn: string,
    name: string,
  ): Record<string, unknown> {
    try {
      if (!raw) throw new Error("Missing policy document");
      const document = JSON.parse(raw.trimStart().startsWith("{") ? raw : decodeURIComponent(raw));
      const statements = Array.isArray(document?.Statement)
        ? document.Statement
        : [document?.Statement];
      if (
        !document ||
        typeof document !== "object" ||
        Array.isArray(document) ||
        statements.length === 0 ||
        statements.some(
          (statement: unknown) =>
            !statement || typeof statement !== "object" || Array.isArray(statement),
        )
      ) {
        throw new Error("Missing policy statements");
      }
      return document;
    } catch (cause) {
      throw new MalformedServiceResponseError(
        `Cannot capture inline policy "${name}" on ${roleArn}.`,
        { cause },
      );
    }
  }

  private incomplete(roleArn: string, operation: string): never {
    throw new MalformedServiceResponseError(
      `Cannot capture execution role ${roleArn}: incomplete ${operation} response.`,
    );
  }
}
