import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentCoreStack } from '../lib/cdk-stack';

test('AgentCoreStack synthesizes with empty spec', () => {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestStack', {
    spec: {
      name: 'testproject',
      version: 1,
      agents: [],
      memories: [],
      credentials: [],
    },
  });
  const template = Template.fromStack(stack);
  template.hasOutput('StackNameOutput', {
    Description: 'Name of the CloudFormation Stack',
  });
});
