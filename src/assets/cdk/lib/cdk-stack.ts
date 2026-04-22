import {
  AgentCoreApplication,
  AgentCoreMcp,
  type AgentCoreProjectSpec,
  type AgentCoreMcpSpec,
} from '@aws/agentcore-cdk';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';

export interface AgentCoreStackProps extends StackProps {
  /**
   * The AgentCore project specification containing agents, memories, and credentials.
   */
  spec: AgentCoreProjectSpec;
  /**
   * The MCP specification containing gateways and servers.
   */
  mcpSpec?: AgentCoreMcpSpec;
  /**
   * Credential provider ARNs from deployed state, keyed by credential name.
   */
  credentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string }>;
  /**
   * Harness role configurations. Each entry creates an IAM execution role for a harness.
   *
   * When `dockerfile` + `codeLocation` are provided (and `containerUri` is not), the stack
   * also builds and pushes a linux/arm64 Docker image as a CDK asset and emits its URI as
   * a stack output named `ApplicationHarness<PascalName>ImageUri`, which the post-CDK
   * harness deployer uses as the `environmentArtifact.containerConfiguration.containerUri`.
   */
  harnesses?: {
    name: string;
    executionRoleArn?: string;
    memoryName?: string;
    containerUri?: string;
    hasDockerfile?: boolean;
    dockerfile?: string;
    codeLocation?: string;
    tools?: { type: string; name: string }[];
    apiKeyArn?: string;
  }[];
}

/**
 * CDK Stack that deploys AgentCore infrastructure.
 *
 * This is a thin wrapper that instantiates L3 constructs.
 * All resource logic and outputs are contained within the L3 constructs.
 */
export class AgentCoreStack extends Stack {
  /** The AgentCore application containing all agent environments */
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    const { spec, mcpSpec, credentials, harnesses } = props;

    // Create AgentCoreApplication with all agents and harness roles
    this.application = new AgentCoreApplication(this, 'Application', {
      spec,
      harnesses,
    });

    // Build and push harness container images via CDK asset pipeline.
    // Emitted per-harness so the imperative HarnessDeployer can look the URI up
    // by stack-output key when it calls CreateHarness.
    for (const harness of harnesses ?? []) {
      if (!harness.dockerfile || !harness.codeLocation || harness.containerUri) continue;

      const asset = new DockerImageAsset(this, `HarnessImage${toPascalId(harness.name)}`, {
        directory: harness.codeLocation,
        file: harness.dockerfile,
        platform: Platform.LINUX_ARM64,
        assetName: `${spec.name}-${harness.name}-harness`,
      });

      new CfnOutput(this, `ApplicationHarness${toPascalId(harness.name)}ImageUri`, {
        description: `Container image URI for harness "${harness.name}"`,
        value: asset.imageUri,
      });
    }

    // Create AgentCoreMcp if there are gateways configured
    if (mcpSpec?.agentCoreGateways && mcpSpec.agentCoreGateways.length > 0) {
      new AgentCoreMcp(this, 'Mcp', {
        projectName: spec.name,
        mcpSpec,
        agentCoreApplication: this.application,
        credentials,
        projectTags: spec.tags,
      });
    }

    // Stack-level output
    new CfnOutput(this, 'StackNameOutput', {
      description: 'Name of the CloudFormation Stack',
      value: this.stackName,
    });
  }
}

/**
 * Convert arbitrary identifier fragments into a single PascalCase string safe
 * for use in a CloudFormation logical ID. Mirrors the helper in the CLI's
 * `cloudformation/logical-ids` module, inlined here because vended CDK assets
 * cannot import from `src/cli/`.
 */
function toPascalId(...parts: string[]): string {
  return parts
    .map(part =>
      part
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join('')
    )
    .join('');
}
