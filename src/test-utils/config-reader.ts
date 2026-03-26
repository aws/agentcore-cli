import { AgentCoreProjectSpecSchema } from '../schema';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read and parse the agentcore.json config from a project.
 *
 * @param projectPath - Absolute path to the project root
 * @returns Parsed and validated agentcore.json contents
 */
export async function readProjectConfig(projectPath: string) {
  const configPath = join(projectPath, 'agentcore', 'agentcore.json');
  const raw = await readFile(configPath, 'utf-8');
  return AgentCoreProjectSpecSchema.parse(JSON.parse(raw));
}
