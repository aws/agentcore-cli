import { createHash } from "node:crypto";
import type { Project } from "../../../../handlers/project/types";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import { InputValidationError } from "../../../../errors";
import { memoryEnvVarName } from "../../../../projectSchemas/memory";
import type { RuntimeArtifact } from "./packager";
import { TerraformProvider } from "./provider";

/** Terraform JSON strings are expressions unless interpolation markers are escaped. */
export function literal(value: string): string {
  return value.replaceAll("${", () => "$${").replaceAll("%{", () => "%%{");
}

function literals(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, literal(value)]));
}

const ref = (address: string): string => `\${${address}}`;

export type ResourceOutput = {
  resourceType: "runtime" | "memory";
  name: string;
  id: string;
  arn: string;
};

export type TerraformConfiguration = {
  terraform: Record<string, unknown>;
  provider: Record<string, unknown>;
  data: Record<string, unknown>;
  resource: Record<string, Record<string, Record<string, unknown>>>;
  output: Record<string, unknown>;
};

/**
 * Compiles the supported project subset without importing CDK. Unsupported fields
 * fail before packaging, init, or apply rather than disappearing from a deployment.
 */
export class TerraformCompiler {
  constructor(readonly provider = new TerraformProvider()) {}

  validate(project: Project): void {
    for (const [field, value] of Object.entries(project.spec)) {
      if (Array.isArray(value) && value.length > 0 && !["runtimes", "memories"].includes(field)) {
        throw new InputValidationError(`Terraform does not yet support project.${field}.`);
      }
    }
    for (const memory of project.spec.memories) {
      if (memory.eventExpiryDuration < this.provider.minimumRetention) {
        throw new InputValidationError(
          `Memory '${memory.name}' needs at least ${this.provider.minimumRetention} days of retention with this provider.`,
        );
      }
      for (const field of ["strategies", "indexedKeys", "streamDeliveryResources"] as const) {
        const value = memory[field];
        if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
          throw new InputValidationError(`Terraform does not yet support memory.${field}.`);
        }
      }
    }
    for (const runtime of project.spec.runtimes) {
      if (runtime.build !== "CodeZip" || !runtime.runtimeVersion?.startsWith("PYTHON_")) {
        throw new InputValidationError("Terraform currently supports Python CodeZip runtimes.");
      }
      if (
        !/^[a-zA-Z0-9_./-]+\.py$/.test(runtime.entrypoint) ||
        runtime.entrypoint.split("/").includes("..")
      ) {
        throw new InputValidationError(
          "Terraform needs a Python file entrypoint without a handler suffix or traversal.",
        );
      }
      for (const field of [
        "connections",
        "additionalPolicies",
        "requestHeaderAllowlist",
        "filesystemConfigurations",
        "endpoints",
        "authorizerConfiguration",
      ] as const) {
        const value = runtime[field];
        if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
          throw new InputValidationError(`Terraform does not yet support runtime.${field}.`);
        }
      }
      if (runtime.authorizerType && runtime.authorizerType !== "AWS_IAM") {
        throw new InputValidationError(
          "Terraform currently supports AWS_IAM runtime authorization.",
        );
      }
      if (runtime.instrumentation?.enableOtel) {
        throw new InputValidationError("Terraform does not yet configure runtime instrumentation.");
      }
    }
  }

  compile(
    project: Project,
    target: AwsDeploymentTarget,
    artifacts: Record<string, RuntimeArtifact>,
  ): TerraformConfiguration {
    this.validate(project);
    const resource: TerraformConfiguration["resource"] = {};
    const outputs: ResourceOutput[] = [];
    const add = (type: string, key: string, properties: Record<string, unknown>) => {
      (resource[type] ??= {})[key] = properties;
    };
    const physicalName = (name: string) => {
      const result = `${project.name}_${target.name}_${name}`;
      if (result.length > 48) {
        throw new InputValidationError(
          `Resource name '${result}' exceeds 48 characters; shorten the project, target or resource name.`,
        );
      }
      return result;
    };
    const tags = (own?: Record<string, string>) => literals({ ...project.spec.tags, ...own });

    for (const memory of project.spec.memories) {
      const properties = this.provider.memory(memory, physicalName(memory.name), tags(memory.tags));
      if (memory.description) properties.description = literal(memory.description);
      add(this.provider.memoryType, memory.name, properties);
      const address = `${this.provider.memoryType}.${memory.name}`;
      outputs.push({
        resourceType: "memory",
        name: memory.name,
        id: ref(`${address}.${this.provider.memoryId}`),
        arn: ref(`${address}.${this.provider.memoryArn}`),
      });
    }
    // Keep the artifact bucket declared after removing the last runtime. An empty
    // project then removes its agent resources without deleting retained code versions.
    const bucketHash = createHash("sha256")
      .update(`${project.name}/${target.name}/${target.account}/${target.region}`)
      .digest("hex")
      .slice(0, 24);
    add("aws_s3_bucket", "artifacts", {
      bucket: `agentcore-artifacts-${bucketHash}`,
      tags: tags(),
      lifecycle: { prevent_destroy: true },
    });
    add("aws_s3_bucket_public_access_block", "artifacts", {
      bucket: ref("aws_s3_bucket.artifacts.id"),
      block_public_acls: true,
      block_public_policy: true,
      ignore_public_acls: true,
      restrict_public_buckets: true,
    });
    add("aws_s3_bucket_versioning", "artifacts", {
      bucket: ref("aws_s3_bucket.artifacts.id"),
      versioning_configuration: { status: "Enabled" },
    });
    add("aws_s3_bucket_server_side_encryption_configuration", "artifacts", {
      bucket: ref("aws_s3_bucket.artifacts.id"),
      rule: { apply_server_side_encryption_by_default: { sse_algorithm: "AES256" } },
    });

    for (const runtime of project.spec.runtimes) {
      const name = physicalName(runtime.name);
      const artifact = artifacts[runtime.name];
      if (!artifact)
        throw new InputValidationError(`Build the artifact for '${runtime.name}' first.`);
      add("aws_s3_object", runtime.name, {
        bucket: ref("aws_s3_bucket.artifacts.id"),
        key: `artifacts/${runtime.name}/${artifact.sha256}.zip`,
        source: literal(artifact.path.replaceAll("\\", "/")),
        source_hash: artifact.sha256,
        depends_on: [
          "aws_s3_bucket_versioning.artifacts",
          "aws_s3_bucket_server_side_encryption_configuration.artifacts",
          "aws_s3_bucket_public_access_block.artifacts",
        ],
      });
      const objectAddress = `aws_s3_object.${runtime.name}`;
      const memoryOutputs = outputs.filter((item) => item.resourceType === "memory");
      const memoryEnvironment = Object.fromEntries(
        memoryOutputs.map((item) => [memoryEnvVarName(item.name), item.id]),
      );
      // Generated discovery values win, as they must name the deployed resources.
      const environment = {
        ...literals(
          Object.fromEntries((runtime.envVars ?? []).map(({ name, value }) => [name, value])),
        ),
        ...memoryEnvironment,
      };
      if (!runtime.executionRoleArn) {
        add("aws_iam_role", runtime.name, {
          name,
          assume_role_policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: "sts:AssumeRole",
                Principal: { Service: "bedrock-agentcore.amazonaws.com" },
                Condition: { StringEquals: { "aws:SourceAccount": target.account } },
              },
            ],
          }),
          tags: tags(runtime.tags),
        });
        const partition = ref("data.aws_partition.current.partition");
        const memoryStatements = memoryOutputs.length
          ? [
              {
                Effect: "Allow",
                Action: [
                  "bedrock-agentcore:CreateEvent",
                  "bedrock-agentcore:GetEvent",
                  "bedrock-agentcore:ListEvents",
                  "bedrock-agentcore:DeleteEvent",
                ],
                Resource: memoryOutputs.map(({ arn }) => arn),
              },
            ]
          : [];
        add("aws_iam_role_policy", runtime.name, {
          role: ref(`aws_iam_role.${runtime.name}.id`),
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:GetObjectVersion"],
                Resource: `${ref("aws_s3_bucket.artifacts.arn")}/artifacts/${runtime.name}/*`,
              },
              {
                Effect: "Allow",
                Action: [
                  "logs:CreateLogGroup",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents",
                  "logs:DescribeLogStreams",
                ],
                Resource: `arn:${partition}:logs:${target.region}:${target.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
              },
              {
                Effect: "Allow",
                Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                Resource: [
                  `arn:${partition}:bedrock:*::foundation-model/*`,
                  `arn:${partition}:bedrock:*:${target.account}:inference-profile/*`,
                  `arn:${partition}:bedrock:*:${target.account}:application-inference-profile/*`,
                ],
              },
              ...memoryStatements,
            ],
          }),
        });
      }
      add(this.provider.runtimeType, runtime.name, {
        agent_runtime_name: name,
        ...(runtime.description && { description: literal(runtime.description) }),
        role_arn: runtime.executionRoleArn ?? ref(`aws_iam_role.${runtime.name}.arn`),
        agent_runtime_artifact: {
          code_configuration: {
            code: {
              s3: {
                bucket: ref("aws_s3_bucket.artifacts.id"),
                prefix: ref(`${objectAddress}.key`),
                version_id: ref(`${objectAddress}.version_id`),
              },
            },
            runtime: runtime.runtimeVersion,
            entry_point: [runtime.entrypoint],
          },
        },
        network_configuration: {
          network_mode: runtime.networkMode ?? "PUBLIC",
          ...(runtime.networkConfig && {
            network_mode_config: {
              subnets: runtime.networkConfig.subnets,
              security_groups: runtime.networkConfig.securityGroups,
            },
          }),
        },
        ...this.provider.runtime(runtime.protocol ?? "HTTP", runtime.lifecycleConfiguration),
        environment_variables: environment,
        tags: tags(runtime.tags),
        ...(!runtime.executionRoleArn && { depends_on: [`aws_iam_role_policy.${runtime.name}`] }),
      });
      const address = `${this.provider.runtimeType}.${runtime.name}`;
      outputs.push({
        resourceType: "runtime",
        name: runtime.name,
        id: ref(`${address}.agent_runtime_id`),
        arn: ref(`${address}.agent_runtime_arn`),
      });
    }
    return {
      terraform: {
        required_version: ">= 1.10, < 2.0",
        required_providers: this.provider.requiredProviders,
      },
      provider: this.provider.providers(target.region, target.account),
      data: { aws_partition: { current: {} } },
      resource,
      output: {
        agentcore: {
          value: {
            version: 1,
            project: project.name,
            target: { name: target.name, account: target.account, region: target.region },
            resources: outputs,
          },
        },
      },
    };
  }
}
