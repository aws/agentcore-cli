import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({
  framework: 'LangChain_LangGraph',
  modelProvider: 'Gemini',
  requiredEnvVar: 'GEMINI_API_KEY',
  skipInvoke: true,
});
