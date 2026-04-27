import { expect, test } from '../fixtures';

test.describe('Inspector loads', () => {
  test('page renders and shows the agent', async ({ page, testEnv }) => {
    await page.goto('/');

    await expect(page.locator('header')).toBeVisible();

    const agentStatus = page.getByTestId('agent-status');
    await expect(agentStatus).toBeVisible({ timeout: 30_000 });
    await expect(agentStatus).toContainText(testEnv.projectName);
  });
});
