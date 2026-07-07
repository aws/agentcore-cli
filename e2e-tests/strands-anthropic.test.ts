import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({ framework: 'Strands', modelProvider: 'Anthropic', apiKeyEnvVar: 'ANTHROPIC_API_KEY' });
