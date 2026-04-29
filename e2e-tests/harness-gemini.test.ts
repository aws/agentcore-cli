import { createHarnessE2ESuite } from './harness-e2e-helper.js';

createHarnessE2ESuite({ modelProvider: 'gemini', requiredEnvVar: 'GEMINI_API_KEY_ARN', skipMemory: true });
