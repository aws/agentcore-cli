import { createHarnessE2ESuite } from './harness-e2e-helper.js';

createHarnessE2ESuite({ modelProvider: 'open_ai', apiKeyEnvVar: 'OPENAI_API_KEY_ARN', skipMemory: true });
