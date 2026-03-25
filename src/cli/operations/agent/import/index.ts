/**
 * Public API for the Bedrock Agent import feature.
 * Provides executeImportAgent() as the shared handler called by both
 * the TUI hook (useAddAgent) and the non-interactive CLI (AgentPrimitive).
 */
import { APP_DIR, ConfigIO } from '../../../../lib';
import type { RuntimeAuthorizerType, SDKFramework } from '../../../../schema';
import { getBedrockAgentConfig } from '../../../aws/bedrock-import';
import { getErrorMessage } from '../../../errors';
import type { JwtConfigOptions } from '../../../primitives/auth-utils';
import { createManagedOAuthCredential } from '../../../primitives/auth-utils';
import type { AddResult } from '../../../primitives/types';
import type { MemoryOption } from '../../../tui/screens/generate/types';
import { setupPythonProject } from '../../python';
import { writeAgentToProject } from '../generate/write-agent-to-project';
import { LangGraphTranslator } from './langgraph-translator';
import { generatePyprojectToml } from './pyproject-generator';
import { StrandsTranslator } from './strands-translator';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export interface ExecuteImportAgentParams {
  name: string;
  framework: SDKFramework;
  memory: MemoryOption;
  bedrockRegion: string;
  bedrockAgentId: string;
  bedrockAliasId: string;
  configBaseDir: string;
  authorizerType?: RuntimeAuthorizerType;
  jwtConfig?: JwtConfigOptions;
}

export async function executeImportAgent(
  params: ExecuteImportAgentParams
): Promise<AddResult<{ agentName: string; agentPath: string }>> {
  const {
    name,
    framework,
    memory,
    bedrockRegion,
    bedrockAgentId,
    bedrockAliasId,
    configBaseDir,
    authorizerType,
    jwtConfig,
  } = params;
  const projectRoot = dirname(configBaseDir);
  const agentPath = join(projectRoot, APP_DIR, name);

  try {
    // 1. Fetch Bedrock Agent configuration
    const agentConfig = await getBedrockAgentConfig(bedrockRegion, bedrockAgentId, bedrockAliasId);

    // 2. Translate to framework-specific Python code
    const enableMemory = memory !== 'none';
    const translatorOptions = {
      agentConfig,
      enableMemory,
      memoryOption: memory,
      enableObservability: true,
    };

    const translator =
      framework === 'Strands'
        ? new StrandsTranslator(agentConfig, translatorOptions)
        : new LangGraphTranslator(agentConfig, translatorOptions);

    const result = translator.translate();

    // 3. Write generated code to project
    mkdirSync(agentPath, { recursive: true });
    writeFileSync(join(agentPath, 'main.py'), result.mainPyContent, 'utf-8');

    // Write collaborator files
    for (const [fileName, content] of result.collaboratorFiles) {
      writeFileSync(join(agentPath, fileName), content, 'utf-8');
    }

    // 4. Generate pyproject.toml
    const pyprojectContent = generatePyprojectToml(name, framework, result.features);
    writeFileSync(join(agentPath, 'pyproject.toml'), pyprojectContent, 'utf-8');

    // 5. Write agent to project config (reuse existing write-agent-to-project)
    const generateConfig = {
      projectName: name,
      buildType: 'CodeZip' as const,
      sdk: framework,
      modelProvider: 'Bedrock' as const,
      memory,
      language: 'Python' as const,
      protocol: 'HTTP' as const,
      authorizerType,
      jwtConfig,
    };
    await writeAgentToProject(generateConfig, { configBaseDir });

    // 5b. Auto-create OAuth credential for CUSTOM_JWT inbound auth
    if (authorizerType === 'CUSTOM_JWT' && jwtConfig?.clientId && jwtConfig?.clientSecret) {
      const configIO = new ConfigIO({ baseDir: configBaseDir });
      await createManagedOAuthCredential(
        name,
        jwtConfig,
        spec => configIO.writeProjectSpec(spec),
        () => configIO.readProjectSpec()
      );
    }

    // 6. Set up Python environment
    await setupPythonProject({ projectDir: agentPath });

    return { success: true, agentName: name, agentPath };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}
