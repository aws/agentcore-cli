import { ConfigIO } from '../../../lib';

export async function createConfigBundleForAgent(agentName: string, configBaseDir: string): Promise<void> {
  const configIO = new ConfigIO({ baseDir: configBaseDir });
  const project = await configIO.readProjectSpec();

  const bundleName = `${agentName}Config`;
  if ((project.configBundles ?? []).some(b => b.name === bundleName)) return;

  project.configBundles ??= [];
  project.configBundles.push({
    type: 'ConfigurationBundle',
    name: bundleName,
    description: `Configuration for ${agentName} — managed by agentcore CLI`,
    components: {
      [`{{runtime:${agentName}}}`]: {
        configuration: {
          systemPrompt: 'You are a helpful assistant. Use tools when appropriate.',
          toolDescriptions: {
            add_numbers: 'Return the sum of two numbers',
          },
        },
      },
    },
    branchName: 'mainline',
    commitMessage: 'Initial configuration',
  });

  await configIO.writeProjectSpec(project);
}
