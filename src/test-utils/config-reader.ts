import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read and parse the agentcore.json config from a project.
 *
 * @param projectPath - Absolute path to the project root
 * @returns Parsed agentcore.json contents
 */
export async function readProjectConfig(projectPath: string): Promise<Record<string, unknown>> {
  const configPath = join(projectPath, 'agentcore', 'agentcore.json');
  const raw = await readFile(configPath, 'utf-8');
  return JSON.parse(raw);
}
