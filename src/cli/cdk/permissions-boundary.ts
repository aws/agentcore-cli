/**
 * Reads the project's permissions boundary setting for the vended CDK project.
 *
 * Resolution lives here rather than at each call site so that every CDK operation
 * (synth, deploy, diff, destroy) sees the same boundary. A boundary that is applied on
 * deploy but not on diff would show up as permanent drift, and a boundary that is silently
 * skipped by one code path produces roles the account's own boundary policy is meant to cap.
 *
 * @module cdk/permissions-boundary
 */
import { ConfigIO } from '../../lib';
import { PermissionsBoundaryRequiredError } from '../../lib/errors/types';
import { readGlobalConfig } from '../../lib/schemas/io/global-config';
import {
  type PermissionsBoundaryContextValue,
  permissionsBoundaryCdkContext,
  resolvePermissionsBoundary,
} from '../aws/permissions-boundary';
import * as path from 'node:path';

/**
 * Resolve the permissions boundary for the project that owns `cdkProjectDir`
 * (`<project>/agentcore/cdk`), across all sources in the precedence documented on
 * {@link resolvePermissionsBoundary}.
 *
 * An unreadable or invalid agentcore.json is not reported here: the deploy pipeline validates
 * the spec separately and surfaces a far better message than this lookup could.
 */
export async function readPermissionsBoundary(cdkProjectDir: string, override?: string): Promise<string | undefined> {
  let configured: string | undefined;
  try {
    const configIO = new ConfigIO({ baseDir: path.dirname(cdkProjectDir) });
    const spec = await configIO.readProjectSpec();
    configured = spec.iam?.permissionsBoundary;
  } catch {
    // Fall through to the remaining sources.
  }
  const globalRead = await readGlobalConfig();
  return resolvePermissionsBoundary({
    override,
    configured,
    global: globalRead.success ? globalRead.config.permissionsBoundary : undefined,
  });
}

/**
 * CDK context to hand the vended app so aws-cdk-lib attaches the boundary to every IAM role
 * in the stack, or undefined when no boundary is configured.
 */
export async function readPermissionsBoundaryContext(
  cdkProjectDir: string,
  override?: string
): Promise<Record<string, PermissionsBoundaryContextValue> | undefined> {
  const boundary = await readPermissionsBoundary(cdkProjectDir, override);
  return boundary ? permissionsBoundaryCdkContext(boundary) : undefined;
}

/** Depth cap so a self-referential `cause` chain cannot spin forever. */
const MAX_CAUSE_DEPTH = 10;

/**
 * Flatten an error and its `cause` chain into one searchable string. toolkit-lib wraps the
 * CloudFormation failure several layers deep, so the IAM denial is never on the top message.
 */
function flattenErrorMessages(err: unknown, depth = 0): string {
  if (depth >= MAX_CAUSE_DEPTH) {
    return '';
  }
  if (!(err instanceof Error)) {
    return typeof err === 'string' ? err : '';
  }
  const nested = err.cause ? flattenErrorMessages(err.cause, depth + 1) : '';
  return nested ? `${err.message}\n${nested}` : err.message;
}

/**
 * Matches the IAM denial CloudFormation nests inside its handler error, e.g.
 * `... is not authorized to perform: iam:CreateRole on resource: arn:...:role/Foo with an
 * explicit deny in a permissions boundary: arn:aws:iam::111122223333:policy/Boundary`.
 *
 * Deliberately narrow: only `iam:CreateRole` denied by a boundary has the one-line fix this
 * rewrite advertises. A boundary denying some other action needs a different remedy, so those
 * errors are left alone.
 */
const CREATE_ROLE_ACTION = 'iam:CreateRole';
const BOUNDARY_DENY_PATTERN = /explicit deny in a permissions boundary:\s*(arn:[^\s"')]+)/;
const BOUNDARY_DENY_PHRASE = 'explicit deny in a permissions boundary';

/**
 * Whether `text` reports a boundary-denied `iam:CreateRole`.
 *
 * Used both on thrown errors and on the toolkit's progress messages, because which of the two
 * carries the reason depends on how CloudFormation ends the deployment.
 */
export function isPermissionsBoundaryDenial(text: string): boolean {
  return text.includes(CREATE_ROLE_ACTION) && text.includes(BOUNDARY_DENY_PHRASE);
}

export interface PermissionsBoundaryFailureContext {
  /** Boundary the deploy did apply, so a mismatch can be called out. */
  appliedBoundary?: string;
  /**
   * Denial text seen on the toolkit's progress messages during the deploy.
   *
   * A rolled-back create surfaces the resource failure only as a `CDK_TOOLKIT_I5502` progress
   * message and then throws an unrelated `NoStack` error with no cause, so the thrown error on
   * its own is not enough to recognize this failure.
   */
  observedDenial?: string;
}

/**
 * Rewrite a boundary-required deploy failure into {@link PermissionsBoundaryRequiredError}.
 * Any other error is returned unchanged.
 */
export function rewriteIfPermissionsBoundaryRequired(
  err: unknown,
  context: PermissionsBoundaryFailureContext = {}
): unknown {
  const fromError = flattenErrorMessages(err);
  const evidence = isPermissionsBoundaryDenial(fromError)
    ? fromError
    : context.observedDenial && isPermissionsBoundaryDenial(context.observedDenial)
      ? context.observedDenial
      : undefined;
  if (!evidence) {
    return err;
  }
  const requiredBoundaryArn = BOUNDARY_DENY_PATTERN.exec(evidence)?.[1];
  return new PermissionsBoundaryRequiredError(requiredBoundaryArn, context.appliedBoundary, { cause: err });
}
