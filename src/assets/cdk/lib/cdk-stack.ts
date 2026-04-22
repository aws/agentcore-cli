import {
  AgentCoreApplication,
  AgentCoreMcp,
  type AgentCoreProjectSpec,
  type AgentCoreMcpSpec,
  ContainerSourceAssetFromPath,
  AgentEcrRepository,
  ContainerBuildProject,
  ContainerImageBuilder,
} from '@aws/agentcore-cdk';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface HarnessConfig {
  name: string;
  executionRoleArn?: string;
  memoryName?: string;
  containerUri?: string;
  hasDockerfile?: boolean;
  dockerfileName?: string;
  harnessDir?: string;
  tools?: { type: string; name: string }[];
  apiKeyArn?: string;
}

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
   */
  harnesses?: HarnessConfig[];
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

    // Build container images for harnesses that specify a dockerfile (no containerUri).
    // Produces CDK outputs consumed by the imperative harness deployer.
    const harnessesForCdk = harnesses ? [...harnesses] : [];
    if (harnesses) {
      for (let i = 0; i < harnesses.length; i++) {
        const h = harnesses[i]!;
        if (h.hasDockerfile && !h.containerUri && h.harnessDir) {
          const pascalName = h.name.replace(/(^|_)([a-z])/g, (_: string, __: string, c: string) => c.toUpperCase());
          const sourceAsset = new ContainerSourceAssetFromPath(this, `Harness${pascalName}SourceAsset`, {
            sourcePath: h.harnessDir,
          });
          const ecrRepo = new AgentEcrRepository(this, `Harness${pascalName}EcrRepo`, {
            projectName: spec.name,
            agentName: `harness-${h.name}`,
          });
          const buildProject = ContainerBuildProject.getOrCreate(this);
          buildProject.grantPushTo(ecrRepo.repository);
          sourceAsset.asset.grantRead(buildProject.role);

          const builder = new ContainerImageBuilder(this, `Harness${pascalName}ContainerBuild`, {
            buildProject,
            sourceAsset,
            repository: ecrRepo,
            dockerfile: h.dockerfileName ?? 'Dockerfile',
          });

          new CfnOutput(this, `Harness${pascalName}ContainerUriOutput`, {
            value: builder.containerUri,
          });

          // Pass the built containerUri to the harness role construct so it gets ECR pull permissions
          harnessesForCdk[i] = { ...h, containerUri: builder.containerUri };
        }
      }
    }

    // Create AgentCoreApplication with all agents and harness roles
    this.application = new AgentCoreApplication(this, 'Application', {
      spec,
      harnesses: harnessesForCdk.length > 0 ? harnessesForCdk : undefined,
    });

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
