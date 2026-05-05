import { getABTest, updateABTest } from '../../aws/agentcore-ab-tests';
import type { UpdateABTestResult } from '../../aws/agentcore-ab-tests';

/**
 * Poll until the AB test reaches RUNNING status, then stop it.
 * Throws if the test never reaches RUNNING within the allotted attempts.
 */
export async function waitForRunningThenStop(
  region: string,
  abTestId: string,
  name: string,
  maxAttempts = 12,
  delayMs = 10_000
): Promise<UpdateABTestResult> {
  let currentStatus: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await getABTest({ region, abTestId });
    currentStatus = current.executionStatus;
    if (currentStatus === 'RUNNING') break;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  if (currentStatus !== 'RUNNING') {
    throw new Error(
      `AB test "${name}" did not reach RUNNING state after waiting (current: ${currentStatus}). Cannot promote.`
    );
  }
  return updateABTest({ region, abTestId, executionStatus: 'STOPPED' });
}
