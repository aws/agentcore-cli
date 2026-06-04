import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({ framework: 'Strands', modelProvider: 'OpenAI', apiKeyEnvVar: 'OPENAI_API_KEY' });
