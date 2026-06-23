import { createHarnessE2ESuite } from './harness-e2e-helper.js';

// Managed memory (the default) deployed end-to-end: create → deploy (provisions a dedicated
// AgentCore Memory) → invoke → memory round-trip → teardown. The round-trip step is the load-bearing
// assertion: it proves the harness execution role can read/write its managed memory at runtime
// without AccessDenied on bedrock-agentcore:ListEvents — the regression #286/#287 fixed and that the
// ungating must not reintroduce.
createHarnessE2ESuite({ modelProvider: 'bedrock', memoryRoundTrip: true, labelSuffix: 'managed-memory' });
