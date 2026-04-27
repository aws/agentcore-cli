import { expect, sendMessage, test } from '../fixtures';

test.describe('Traces', () => {
  test('traces panel shows trace after invocation', async ({ page }) => {
    await page.goto('/');

    await sendMessage(page, 'Say hello');

    await page.getByRole('tab', { name: 'Traces' }).click();

    const traceList = page.getByTestId('trace-list');
    await expect(traceList).toBeVisible({ timeout: 30_000 });

    const traceButton = traceList.getByRole('button').first();
    await expect(traceButton).toBeVisible({ timeout: 30_000 });

    await traceButton.click();

    const spanRow = page.locator('[role="button"]').filter({ hasText: /.+/ });
    await expect(spanRow.first()).toBeVisible({ timeout: 10_000 });
  });
});
