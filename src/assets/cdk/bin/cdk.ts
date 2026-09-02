#!/usr/bin/env node
import { AgentCoreStack, type HarnessConfig } from '../lib/cdk-stack';
import { ConfigIO, HarnessSpecSchema, type AwsDeploymentTarget } from '@aws/agentcore-cdk';
import { App, type Environment } from 'aws-cdk-lib';
import * as path from 'path';
import * as fs from 'fs';

function toEnvironment(target: AwsDeploymentTarget): Environment {
  return {
    account: target.account,
    region: target.region,
  };
}

function sanitize(name: string): string {
  return name.replace(/_/g, '-');
}

function toStackName(projectName: string, targetName: string): string {
  return `AgentCore-${sanitize(projectName)}-${sanitize(targetName)}`;
}

// The vended CDK project compiles against the published @aws/agentcore-cdk schema
// type, which may lag the CLI's own AgentCoreProjectSpec (e.g. payments, harnesses,
// gateway fields). This alias documents each read of those not-yet-published fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpecWithLatestFields = any;

// Extract MCP configuration from the project spec. Gateway fields are stored in
// agentcore.json but may not yet be on the published spec type, so they are read
// off the loosened alias.
function resolveMcpSpec(spec: SpecWithLatestFields) {
  return spec.agentCoreGateways?.length
    ? {
        agentCoreGateways: spec.agentCoreGateways,
        mcpRuntimeTools: spec.mcpRuntimeTools,
        unassignedTargets: spec.unassignedTargets,
      }
    : undefined;
}

// Read non-S3 KB connector-config files and return their parsed contents keyed by
// the data source's connectorConfigFile path. The L3 does not read files; it
// expects these parsed connectorParameters verbatim.
function resolveConnectorParametersByFile(
  spec: SpecWithLatestFields,
  projectRoot: string
): Record<string, Record<string, unknown>> {
  const connectorParametersByFile: Record<string, Record<string, unknown>> = {};
  for (const kb of spec.knowledgeBases ?? []) {
    for (const ds of kb.dataSources ?? []) {
      if (ds.type !== 'S3' && ds.connectorConfigFile) {
        const abs = path.resolve(projectRoot, ds.connectorConfigFile);
        try {
          connectorParametersByFile[ds.connectorConfigFile] = JSON.parse(fs.readFileSync(abs, 'utf-8'));
        } catch (err) {
          throw new Error(
            `Could not read connector config '${ds.connectorConfigFile}' for knowledge base '${kb.name}' at ${abs}: ${err instanceof Error ? err.message : err}`
          );
        }
      }
    }
  }
  return connectorParametersByFile;
}

// Synthesize a HarnessConfig for each harness entry in the spec. The full validated
// spec drives the AWS::BedrockAgentCore::Harness CFN resource; the role-scoped
// fields drive the IAM role + container build.
function resolveHarnessConfigs(spec: SpecWithLatestFields, projectRoot: string): HarnessConfig[] {
  const harnessConfigs: HarnessConfig[] = [];
  for (const entry of spec.harnesses ?? []) {
    const harnessDir = path.resolve(projectRoot, entry.path);
    const harnessPath = path.resolve(harnessDir, 'harness.json');
    try {
      const harnessSpec = HarnessSpecSchema.parse(JSON.parse(fs.readFileSync(harnessPath, 'utf-8')));
      harnessConfigs.push({
        name: entry.name,
        executionRoleArn: harnessSpec.executionRoleArn,
        // Only an `existing` memory ref carries a name to wire IAM against; managed memory is
        // owned by the harness (no sibling) and disabled has none — both resolve to undefined.
        memoryName: harnessSpec.memory?.mode === 'existing' ? harnessSpec.memory.name : undefined,
        containerUri: harnessSpec.containerUri,
        hasDockerfile: !!harnessSpec.dockerfile,
        dockerfile: harnessSpec.dockerfile,
        codeLocation: harnessSpec.dockerfile ? harnessDir : undefined,
        tools: harnessSpec.tools,
        skills: harnessSpec.skills,
        apiKeyArn: harnessSpec.model?.apiKeyArn,
        efsAccessPoints: harnessSpec.efsAccessPoints,
        s3AccessPoints: harnessSpec.s3AccessPoints,
        apiFormat: harnessSpec.model?.apiFormat,
        // Full spec + dir drive the AWS::BedrockAgentCore::Harness CFN resource.
        spec: harnessSpec,
        harnessDir,
      });
    } catch (err) {
      throw new Error(
        `Could not read harness.json for "${entry.name}" at ${harnessPath}: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  return harnessConfigs;
}

async function main() {
  // Config root is parent of cdk/ directory. The CLI sets process.cwd() to agentcore/cdk/.
  const configRoot = path.resolve(process.cwd(), '..');
  const configIO = new ConfigIO({ baseDir: configRoot });

  const spec = await configIO.readProjectSpec();
  const targets = await configIO.readAWSDeploymentTargets();

  // `project build` runs before a project has anywhere to deploy, so an empty target
  // list is not an error: it synthesizes a single environment-agnostic stack, which is
  // enough to typecheck the app and produce a template. Only a stack synthesized for a
  // real target is a deploy candidate; the target tag below is what marks one.
  const stackTargets: (AwsDeploymentTarget | undefined)[] = targets.length > 0 ? targets : [undefined];

  const specAny: SpecWithLatestFields = spec;
  const projectRoot = path.resolve(configRoot, '..');

  const mcpSpec = resolveMcpSpec(specAny);
  const connectorParametersByFile = resolveConnectorParametersByFile(specAny, projectRoot);
  const harnessConfigs = resolveHarnessConfigs(specAny, projectRoot);

  // Read deployed state for credential ARNs (populated by pre-deploy identity setup).
  // Under agentcore/.cli/ to match the released CLI's location.
  let deployedState: Record<string, unknown> | undefined;
  try {
    deployedState = JSON.parse(fs.readFileSync(path.join(configRoot, '.cli', 'deployed-state.json'), 'utf8'));
  } catch (err) {
    // A missing file is the normal first-deploy case. A malformed one is not:
    // surface it rather than silently synthesizing without the credential ARNs
    // it holds (which would drop them from the stack).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const app = new App();

  for (const target of stackTargets) {
    // An environment-agnostic stack resolves its account and region from CloudFormation
    // pseudo-parameters at deploy time instead of pinning them at synth time.
    const env = target ? toEnvironment(target) : undefined;
    const stackName = target ? toStackName(spec.name, target.name) : `AgentCore-${sanitize(spec.name)}`;

    // Extract credentials from deployed state for this target
    const targetState = (deployedState as Record<string, unknown>)?.targets as
      Record<string, Record<string, unknown>> | undefined;
    const targetResources = target
      ? (targetState?.[target.name]?.resources as Record<string, unknown> | undefined)
      : undefined;
    const credentials = targetResources?.credentials as
      Record<string, { credentialProviderArn: string; clientSecretArn?: string }> | undefined;

    new AgentCoreStack(app, stackName, {
      spec,
      mcpSpec,
      credentials,
      connectorParametersByFile,
      harnesses: harnessConfigs.length > 0 ? harnessConfigs : undefined,
      env,
      description: target
        ? `AgentCore stack for ${spec.name} deployed to ${target.name} (${target.region})`
        : `AgentCore stack for ${spec.name} (no deployment target configured)`,
      // Only a stack synthesized for a real target carries the target tag, which is
      // how deploy selects the stack to ship.
      tags: {
        'agentcore:project-name': spec.name,
        ...(target ? { 'agentcore:target-name': target.name } : {}),
      },
    });
  }

  app.synth();
}

main().catch((error: unknown) => {
  console.error('AgentCore CDK synthesis failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
