import z from "zod";
import type {
  AuthorizerConfiguration,
  LifecycleConfiguration,
  NetworkConfiguration,
  VpcConfig,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../errors";
import { flag } from "../../router";
import { ContainerUriSchema } from "../../projectSchemas/container";
import { NetworkModeSchema, ProtocolModeSchema } from "../../projectSchemas/constants";
import { regionFromArn } from "../../core/arn";
import type { CoreOptions } from "../../core/types";
import { parseJsonFlag } from "../utils";
import { runtimeParameterHelp as help } from "./parameterHelp";

// Settings `runtime create` and `runtime update` both accept. Structured API
// parameters are JSON documents, as on `harness create`; the service validates
// their contents.
export const runtimeSettingFlags = (containerUri: "required" | "optional") =>
  [
    flag(
      "container-uri",
      "pre-built Linux ARM64 image in Amazon ECR (private or public.ecr.aws)",
      containerUri === "required" ? ContainerUriSchema : ContainerUriSchema.optional(),
      { help: help.containerUri },
    ),
    flag(
      "execution-role-arn",
      containerUri === "required"
        ? "IAM role the Runtime assumes; a default role scoped to the image is created when omitted"
        : "IAM role the Runtime assumes",
      z.string().optional(),
      { help: help.executionRoleArn },
    ),
    flag("description", "a description of the Runtime", z.string().max(200).optional()),
    flag(
      "protocol",
      "protocol the container serves: HTTP (default), MCP, A2A, or AGUI",
      ProtocolModeSchema.optional(),
      { help: help.protocol },
    ),
    flag(
      "environment-variables",
      containerUri === "required"
        ? "environment variables (JSON object of key/value strings)"
        : "environment variables (JSON object; replaces all existing)",
      z.string().optional(),
      { help: help.environmentVariables },
    ),
    flag(
      "network-mode",
      "network mode for the Runtime (PUBLIC or VPC)",
      NetworkModeSchema.optional(),
    ),
    flag("network-config", "VPC subnets and security groups (JSON)", z.string().optional(), {
      help: help.networkConfig,
    }),
    flag(
      "authorizer-configuration",
      "inbound authorizer configuration (JSON AuthorizerConfiguration)",
      z.string().optional(),
      { help: help.authorizerConfiguration },
    ),
    flag(
      "lifecycle-configuration",
      "session idle timeout and maximum lifetime (JSON LifecycleConfiguration)",
      z.string().optional(),
      { help: help.lifecycleConfiguration },
    ),
  ] as const;

type SettingFlags = {
  "container-uri"?: string;
  "execution-role-arn"?: string;
  description?: string;
  protocol?: z.infer<typeof ProtocolModeSchema>;
  "environment-variables"?: string;
  "network-mode"?: z.infer<typeof NetworkModeSchema>;
  "network-config"?: string;
  "authorizer-configuration"?: string;
  "lifecycle-configuration"?: string;
};

function networkConfiguration(flags: SettingFlags): NetworkConfiguration | undefined {
  const vpc = parseJsonFlag<VpcConfig>("network-config", flags["network-config"]);
  if (vpc !== undefined && flags["network-mode"] !== "VPC") {
    throw new InputValidationError("--network-config requires --network-mode VPC");
  }
  if (flags["network-mode"] === "VPC" && vpc === undefined) {
    throw new InputValidationError("--network-mode VPC requires --network-config");
  }
  if (flags["network-mode"] === undefined) return undefined;
  return {
    networkMode: flags["network-mode"],
    ...(vpc !== undefined && { networkModeConfig: vpc }),
  };
}

/** The Runtime settings the flags state; omitted flags stay undefined. */
export function runtimeSettings(flags: SettingFlags) {
  return {
    containerUri: flags["container-uri"],
    executionRoleArn: flags["execution-role-arn"],
    description: flags.description,
    protocol: flags.protocol,
    environmentVariables: parseJsonFlag<Record<string, string>>(
      "environment-variables",
      flags["environment-variables"],
    ),
    networkConfiguration: networkConfiguration(flags),
    authorizerConfiguration: parseJsonFlag<AuthorizerConfiguration>(
      "authorizer-configuration",
      flags["authorizer-configuration"],
    ),
    lifecycleConfiguration: parseJsonFlag<LifecycleConfiguration>(
      "lifecycle-configuration",
      flags["lifecycle-configuration"],
    ),
  };
}

export const runtimeFlag = flag("runtime", "the Runtime: its name, ID, or ARN", z.string().min(1), {
  help: help.runtime,
});

/** An ARN selects its own region; a name or ID uses the command's region. */
export function optionsForRuntime(identifier: string, options: CoreOptions): CoreOptions {
  const region = regionFromArn(identifier);
  return region ? { ...options, region } : options;
}
