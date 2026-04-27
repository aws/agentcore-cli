import { expect, test } from '../fixtures';

test.describe('Resources', () => {
  test('resource panel shows the agent', async ({ page, testEnv }) => {
    await page.goto('/');

    const resourcePanel = page.getByTestId('resource-panel');
    await expect(resourcePanel).toBeVisible({ timeout: 10_000 });

    const resourcesTab = resourcePanel.getByRole('tab', { name: 'Resources' });
    await resourcesTab.click();

    const agentNode = resourcePanel.getByRole('button', { name: new RegExp(`agent: ${testEnv.projectName}`, 'i') });
    await expect(agentNode).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Toggle resource panel' }).click();
    await expect(resourcePanel).not.toBeVisible();
  });
});
