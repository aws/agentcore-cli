import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({ framework: 'LangChain_LangGraph', modelProvider: 'Anthropic', apiKeyEnvVar: 'ANTHROPIC_API_KEY' });
