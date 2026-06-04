import { createHarnessE2ESuite } from './harness-e2e-helper.js';

createHarnessE2ESuite({
  modelProvider: 'gemini',
  apiKeyEnvVar: 'GEMINI_API_KEY_ARN',
  skipMemory: true,
  skipInvoke: true,
});
