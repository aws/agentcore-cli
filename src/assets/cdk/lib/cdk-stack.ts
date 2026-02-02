import { AgentCoreApplication, AgentCoreMcp, type AgentCoreProjectSpec } from '@aws/agentcore-l3-cdk-constructs';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface AgentCoreStackProps extends StackProps {
  /**
   * The complete AgentCore workspace specification containing all agents and MCP config.
   */
  spec: AgentCoreProjectSpec;
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

  /** The MCP construct if MCP is configured */
  public readonly mcp?: AgentCoreMcp;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    const { spec } = props;

    // Create AgentCoreApplication with all agents
    this.application = new AgentCoreApplication(this, 'Application', {
      spec,
    });

    // Instantiate AgentCoreMcp if MCP is defined
    if (spec.mcp) {
      this.mcp = new AgentCoreMcp(this, 'Mcp', {
        spec,
        agentCoreApplication: this.application,
      });
    }

    // Stack-level output
    new CfnOutput(this, 'StackNameOutput', {
      description: 'Name of the CloudFormation Stack',
      value: this.stackName,
    });
  }
}
