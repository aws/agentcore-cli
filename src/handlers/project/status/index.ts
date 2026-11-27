import z from "zod";
import type { AppIO } from "../../../io";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import {
  CommandRunMetricEventKey,
  createHandler,
  flag,
  ProjectKey,
  type Middleware,
} from "../../../router";
import { JsonRendererKey } from "../../../tui";
import type { AwsIdentity, ProjectManager, ResolvedProjectResource } from "../types";
import { accountMismatchWarning, awsIdentitySummary, isAccountMismatch } from "./identity";

type StatusProjectHandlerConfig = {
  projectManager: ProjectManager;
  io: AppIO;
  middlewares?: Middleware[];
};

type ProjectStatus = {
  projectName: string;
  target: string;
  region: string;
  /** The AWS account the target is configured for in aws-targets.json. */
  targetAccount: string;
  /** The AWS account behind the active credentials, which may differ. */
  awsIdentity: AwsIdentity;
  resources: ResolvedProjectResource[];
};

export const createStatusProjectHandler = (config: StatusProjectHandlerConfig) =>
  createHandler({
    name: "status",
    description: "inspect deployed project resources for an AWS target",
    middlewares: config.middlewares,
    flags: [
      flag(
        "target",
        "name of the aws-targets.json entry to report on",
        z.string().default(DEFAULT_TARGET_NAME),
      ),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      const resolved = await config.projectManager.resolveProjectResources(project, {
        target: flags.target,
      });
      const { target } = resolved;
      // Resolved in the target's region so credentials for another partition
      // (GovCloud, China) reach the STS endpoint that accepts them.
      const awsIdentity = await config.projectManager.resolveAwsIdentity(target.region);

      const mismatch = isAccountMismatch(awsIdentity, target);
      ctx.value(CommandRunMetricEventKey)?.setAttributes({
        aws_identity_resolved: awsIdentity.success,
        aws_account_mismatch: mismatch,
      });
      // stdout carries only the JSON document, so the human-readable notes go to stderr.
      if (!awsIdentity.success) {
        config.io.stderr.write(`warning: ${awsIdentitySummary(awsIdentity)}\n`);
      } else if (mismatch) {
        config.io.stderr.write(`warning: ${accountMismatchWarning(awsIdentity.account, target)}\n`);
      }

      const status: ProjectStatus = {
        projectName: project.name,
        target: target.name,
        region: target.region,
        targetAccount: target.account,
        awsIdentity,
        resources: resolved.resources,
      };

      ctx.require(JsonRendererKey).renderJson(status);
    },
  });
