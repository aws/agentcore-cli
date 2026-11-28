#!/usr/bin/env node
import { App, DefaultStackSynthesizer } from 'aws-cdk-lib';
import { readAgentCoreProject, resolveTargetStacks, transformAgentCoreJson } from '@aws/agentcore-cdk';
import { AgentCoreStack } from '../lib/cdk-stack';

try {
  // The AgentCore CLI runs this app from agentcore/cdk/; readAgentCoreProject walks up to agentcore/.
  const project = readAgentCoreProject();
  const app = new App();
  // Box: every file asset of the stack (the agent code, the container build source, and the template)
  // goes under strands-box/, so the code location of each runtime in a Box project shows that it
  // belongs to the Box project. It is per stack, so it also covers a runtime with no `box`.
  const boxProject = isBoxProject(project.agentCoreJson);
  for (const stack of resolveTargetStacks({
    projectName: project.projectName,
    targets: project.targets,
    deployedState: project.deployedState,
  })) {
    new AgentCoreStack(app, stack.stackName, {
      env: stack.env,
      tags: stack.tags,
      description: stack.description,
      synthesizer: boxProject ? new DefaultStackSynthesizer({ bucketPrefix: 'strands-box/' }) : undefined,
      application: transformAgentCoreJson(project.agentCoreJson, {
        projectRoot: project.projectRoot,
        credentials: stack.credentials,
        target: stack.target,
      }),
    });
  }
  app.synth();
} catch (error) {
  console.error('AgentCore CDK synthesis failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}

/** Whether agentcore.json has `"projectType": "box"`. readAgentCoreProject returns it as `unknown`. */
function isBoxProject(agentCoreJson: unknown): boolean {
  return (
    typeof agentCoreJson === 'object' &&
    agentCoreJson !== null &&
    'projectType' in agentCoreJson &&
    agentCoreJson.projectType === 'box'
  );
}
