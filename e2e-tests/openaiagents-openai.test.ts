import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({ framework: 'OpenAIAgents', modelProvider: 'OpenAI', apiKeyEnvVar: 'OPENAI_API_KEY' });
