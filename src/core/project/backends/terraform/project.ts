import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { ProjectStateError } from "../../../../errors";
import { atomicWrite } from "../../../../io";
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import type { TerraformAssets } from "./types";

const ROOT_FILES: Record<string, string> = {
  "main.tf": `# This root is yours to edit. The CLI refreshes artifacts.json and target inputs.
module "application" {
  source      = "git::https://github.com/jariy17/agentcore-l3-cdk-constructs.git//terraform/modules/agentcore-application?ref=d3ce7229610ce0bb56d581c55f710e220b58faa4"
  spec        = jsondecode(file("\${path.module}/../agentcore.json"))
  target_name = var.target_name
  account_id  = var.account_id
  region      = var.region
  artifacts   = jsondecode(file("\${path.module}/artifacts.json"))
}
`,
  "providers.tf": `terraform {
  required_version = ">= 1.12.0, < 2.0.0"
  backend "local" {
    path = ".targets/default/terraform.tfstate"
  }
  required_providers {
    awscc = {
      source  = "hashicorp/awscc"
      version = "= 1.106.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.69.0"
    }
  }
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
}

provider "awscc" {
  region = var.region
}

# Ensures the account guard also runs for projects containing only AWSCC resources.
data "aws_caller_identity" "current" {}
`,
  "variables.tf": `variable "target_name" {
  type        = string
  description = "Logical deployment target name."
  default     = "default"
  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{0,63}$", var.target_name))
    error_message = "target_name must be a valid AgentCore deployment target name."
  }
}

variable "account_id" {
  type        = string
  description = "Expected AWS account ID."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must contain exactly 12 digits."
  }
}

variable "region" {
  type        = string
  description = "AWS region for this deployment."
  default     = "us-west-2"
}
`,
  "outputs.tf": `output "project_resources" {
  value = module.application.project_resources
  precondition {
    condition     = data.aws_caller_identity.current.account_id == var.account_id
    error_message = "AWS credentials do not match the configured deployment account."
  }
}

output "runtimes" {
  value = module.application.runtimes
}

output "memories" {
  value = module.application.memories
}

output "gateways" {
  value = module.application.gateways
}

output "policy_engines" {
  value = module.application.policy_engines
}

output "online_evaluations" {
  value = module.application.online_evaluations
}

# Lets CLI commands verify state created through Terraform directly.
output "deployment_target" {
  value = {
    name    = var.target_name
    account = var.account_id
    region  = var.region
  }
}
`,
};

/** Scaffolds an editable root around the pinned HCL module; never translates resources in TypeScript. */
export class TerraformProjectWriter {
  /** Create usable, editable Terraform source without Terraform or AWS credentials. */
  async scaffold(directory: string, region?: string): Promise<void> {
    await this.assertCompatible(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // wx is intentional: customer changes to the root survive every subsequent build/deploy.
    for (const [filename, source] of Object.entries(ROOT_FILES)) {
      const contents =
        filename === "variables.tf" && region
          ? source.replace('default     = "us-west-2"', `default     = ${JSON.stringify(region)}`)
          : source;
      await this.writeIfMissing(join(directory, filename), contents);
    }
    await this.writeIfMissing(
      join(directory, "artifacts.json"),
      `${JSON.stringify({ runtimes: {}, gatewayTargets: {} }, null, 2)}\n`,
    );
  }

  async assertCompatible(directory: string): Promise<void> {
    if (existsSync(join(directory, "main.tf.json"))) {
      throw new ProjectStateError(
        `The earlier Terraform PoC configuration exists at ${join(directory, "main.tf.json")}. ` +
          "Automatic migration to module.application is not supported. Preserve any state and use a new deployment directory.",
      );
    }
    // Existing HCL roots may contain customer resources alongside module.application.
    // Account and region identity are checked by TerraformState before CLI deployment.
    if (existsSync(join(directory, "main.tf"))) return;
    for (const filename of ["terraform.tfstate", "terraform.tfstate.backup"]) {
      const text = await this.readOptional(join(directory, filename));
      if (text === undefined) continue;
      const state = JSON.parse(text) as {
        resources?: { mode?: string; module?: string }[];
      };
      if (
        state.resources?.some(
          (resource) =>
            resource.mode === "managed" &&
            resource.module !== "module.application" &&
            !resource.module?.startsWith("module.application."),
        )
      ) {
        throw new ProjectStateError(
          `The Terraform state in ${directory} contains resources outside module.application. ` +
            "Automatic state migration is not supported; preserve the state and use a new deployment directory.",
        );
      }
    }
  }

  async write(
    directory: string,
    target: AwsDeploymentTarget | undefined,
    assets: TerraformAssets,
  ): Promise<void> {
    await this.assertCompatible(directory);
    const portableAssets: TerraformAssets = { runtimes: {}, gatewayTargets: {} };
    for (const kind of ["runtimes", "gatewayTargets"] as const) {
      for (const [name, artifact] of Object.entries(assets[kind])) {
        const path = relative(directory, artifact.path).replaceAll("\\", "/");
        this.checkRelativePath(path);
        portableAssets[kind][name] = { path, hash: artifact.hash };
      }
    }
    await this.scaffold(directory);
    await atomicWrite(
      join(directory, "artifacts.json"),
      `${JSON.stringify(portableAssets, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (target) {
      const targetDirectory = join(directory, ".targets", target.name);
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      await atomicWrite(
        join(targetDirectory, "deployment.tfvars.json"),
        `${JSON.stringify({ target_name: target.name, account_id: target.account, region: target.region }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  }

  private checkRelativePath(path: string): void {
    if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
      throw new ProjectStateError(`Invalid Terraform artifact path: ${path}`);
    }
  }

  private async readOptional(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeIfMissing(path: string, contents: string): Promise<void> {
    try {
      await writeFile(path, contents, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
