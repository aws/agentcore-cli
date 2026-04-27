import { expect, test } from '../fixtures';

test.describe('Start agent', () => {
  test('agent starts and shows running status', async ({ page }) => {
    await page.goto('/');

    const agentStatus = page.getByTestId('agent-status');
    await expect(agentStatus).toBeVisible({ timeout: 30_000 });

    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 60_000 });
    await expect(chatInput).toBeEnabled({ timeout: 60_000 });

    await expect(page.getByText('Error')).not.toBeVisible();
  });
});
