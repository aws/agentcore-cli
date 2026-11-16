#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { readAgentCoreProject, resolveTargetStacks, transformAgentCoreJson } from '@aws/agentcore-cdk';
import { AgentCoreStack } from '../lib/cdk-stack';

try {
  // `agentcore build` sets this so a project can synthesize a template before its first deploy
  // provisions its credential providers. Any credential deployed state lacks then resolves to a
  // placeholder ARN instead of throwing. Deploy does not set it, so a missing credential still fails.
  const allowUnresolvedCredentials = process.env.AGENTCORE_BUILD_ALLOW_UNRESOLVED_CREDENTIALS === '1';
  // The AgentCore CLI runs this app from agentcore/cdk/; readAgentCoreProject walks up to agentcore/.
  const project = readAgentCoreProject();
  const app = new App();
  for (const stack of resolveTargetStacks({
    projectName: project.projectName,
    targets: project.targets,
    deployedState: project.deployedState,
  })) {
    new AgentCoreStack(app, stack.stackName, {
      env: stack.env,
      tags: stack.tags,
      description: stack.description,
      application: transformAgentCoreJson(project.agentCoreJson, {
        projectRoot: project.projectRoot,
        credentials: stack.credentials,
        target: stack.target,
        allowUnresolvedCredentials,
      }),
    });
  }
  app.synth();
} catch (error) {
  console.error('AgentCore CDK synthesis failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
