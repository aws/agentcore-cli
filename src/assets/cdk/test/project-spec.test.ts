import { parseProjectSpec } from '../lib/project-spec';
import { AgentCoreStack } from '../lib/cdk-stack';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const keyArn = 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012';

function project(kmsKeyArn?: unknown) {
  return {
    name: 'testproject', version: 1, managedBy: 'CDK', runtimes: [],
    knowledgeBases: [{ name: 'docs', type: 'AgentCoreKnowledgeBase', dataSources: [
      { type: 'S3', uri: 's3://my-bucket/docs/', ...(kmsKeyArn === undefined ? {} : { kmsKeyArn }) },
    ] }],
  };
}

test('preserves S3 encryption keys through the published schema without mutating the input', () => {
  const input = project(keyArn);
  const parsed = parseProjectSpec(input);
  expect(parsed.knowledgeBaseKmsKeys).toEqual({ docs: [keyArn] });
  expect(parsed.spec.knowledgeBases?.[0]?.dataSources[0]).toEqual({ type: 'S3', uri: 's3://my-bucket/docs/' });
  expect(input.knowledgeBases[0].dataSources[0].kmsKeyArn).toBe(keyArn);
  const stack = new AgentCoreStack(new App(), 'ParsedStack', parsed);
  const policies = Template.fromStack(stack).findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap(policy => policy.Properties.PolicyDocument.Statement);
  expect(statements.filter(statement => statement.Action === 'kms:Decrypt')).toHaveLength(1);
  expect(statements.find(statement => statement.Action === 'kms:Decrypt').Resource).toBe(keyArn);
});

test.each(['*', 'arn:aws:kms:us-east-1:123456789012:alias/key', '', null, 123])('rejects invalid encryption key %j', value => {
  expect(() => parseProjectSpec(project(value))).toThrow('Invalid S3 kmsKeyArn');
});

test('retains strict validation of unknown data source fields', () => {
  const input = project(keyArn);
  const source = { ...input.knowledgeBases[0].dataSources[0], unexpected: true };
  expect(() => parseProjectSpec({ ...input, knowledgeBases: [{ ...input.knowledgeBases[0], dataSources: [source] }] })).toThrow();
});

test('unencrypted S3 sources do not grant KMS permissions', () => {
  const parsed = parseProjectSpec(project());
  expect(parsed.knowledgeBaseKmsKeys).toEqual({});
  const stack = new AgentCoreStack(new App(), 'UnencryptedStack', parsed);
  const policies = Template.fromStack(stack).findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap(policy => policy.Properties.PolicyDocument.Statement);
  expect(statements.some(statement => statement.Action === 'kms:Decrypt')).toBe(false);
});

test.each([null, [], { knowledgeBases: [null] }, { knowledgeBases: [{ dataSources: null }] }])('rejects malformed project %j', value => {
  expect(() => parseProjectSpec(value)).toThrow();
});

test('connector sources retain published schema validation', () => {
  const input = project();
  const connector = { type: 'WEB', connectorConfigFile: 'app/docs/connector.json' };
  const parsed = parseProjectSpec({ ...input, knowledgeBases: [{ ...input.knowledgeBases[0], dataSources: [connector] }] });
  expect(parsed.spec.knowledgeBases?.[0]?.dataSources[0]).toEqual(connector);
  expect(parsed.knowledgeBaseKmsKeys).toEqual({});
  expect(() => parseProjectSpec({ ...input, knowledgeBases: [{ ...input.knowledgeBases[0], dataSources: [{ ...connector, kmsKeyArn: keyArn }] }] })).toThrow();
});
