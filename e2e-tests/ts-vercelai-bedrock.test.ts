import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({
  framework: 'VercelAI',
  modelProvider: 'Bedrock',
  language: 'TypeScript',
  skipObservability: true,
});
