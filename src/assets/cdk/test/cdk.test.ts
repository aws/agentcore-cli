import { AgentCoreProjectSpecSchema } from '@aws/agentcore-cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentCoreStack } from '../lib/cdk-stack';

test('AgentCoreStack synthesizes with empty spec', () => {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestStack', {
    spec: {
      name: 'testproject',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      configBundles: [],
      policyEngines: [],
      payments: [],
      agentCoreGateways: [],
      mcpRuntimeTools: [],
      unassignedTargets: [],
      datasets: [],
      knowledgeBases: [],
    },
  });
  const template = Template.fromStack(stack);
  template.hasOutput('StackNameOutput', {
    Description: 'Name of the CloudFormation Stack',
  });
});


test.each([
  ['aws', 'us-east-1'],
  ['aws-cn', 'cn-north-1'],
  ['aws-us-gov', 'us-gov-west-1'],
])('S3 ingestion grants scoped decrypt in %s', (partition, region) => {
  const app = new cdk.App();
  const keyArn = `arn:${partition}:kms:${region}:123456789012:key/12345678-1234-1234-1234-123456789012`;
  const props = {
    env: { account: '123456789012', region },
    spec: AgentCoreProjectSpecSchema.parse({
      name: 'testproject', version: 1, managedBy: 'CDK' as const, runtimes: [],
      knowledgeBases: [{ name: 'docs', type: 'AgentCoreKnowledgeBase' as const,
        dataSources: [{ type: 'S3' as const, uri: 's3://my-bucket/docs/' }] }],
    }),
    knowledgeBaseKmsKeys: { docs: [keyArn] },
  };
  const stack = new AgentCoreStack(app, 'EncryptedStack', props);
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([{
        Action: 'kms:Decrypt', Effect: 'Allow', Resource: keyArn,
        Condition: { StringEquals: { 'kms:ViaService': stack.resolve(`s3.${stack.region}.${stack.urlSuffix}`) } },
      }]),
    },
  });
});
