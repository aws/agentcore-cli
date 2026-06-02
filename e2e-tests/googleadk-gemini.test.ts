import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({ framework: 'GoogleADK', modelProvider: 'Gemini', requiredEnvVar: 'GEMINI_API_KEY', skipInvoke: true });
