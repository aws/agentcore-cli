import { createE2ESuite } from './e2e-helper.js';

createE2ESuite({
  framework: 'Strands',
  modelProvider: 'Bedrock',
  lifecycleConfig: { idleTimeout: 120, maxLifetime: 3600 },
});
