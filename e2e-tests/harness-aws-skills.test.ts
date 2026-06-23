import { createHarnessE2ESuite } from './harness-e2e-helper.js';

// AWS Skills deployed end-to-end: create → add skill --aws-skills → deploy → invoke → confirm the
// deployed agent actually loaded the skills → teardown. Uses disabled memory so the deploy is fast
// (no managed-memory provisioning) — this suite is about skills, not memory, which managed-memory
// e2e covers. The 'loads AWS skills' step asks the agent what skills it has and asserts it references
// the AWS ones, proving the spec → CFN → runtime path works, not just that the flag parses.
createHarnessE2ESuite({
  modelProvider: 'bedrock',
  awsSkills: 'core-skills/*',
  skipMemory: true,
  labelSuffix: 'aws-skills',
});
