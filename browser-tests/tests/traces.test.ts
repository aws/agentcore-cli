import { expect, sendMessage, test } from '../fixtures';

test.describe('Traces', () => {
  test('traces panel shows span tree after invocation', async ({ page }) => {
    await page.goto('/');

    await sendMessage(page, 'Say hello');

    const resourcePanel = page.getByTestId('resource-panel');
    await expect(resourcePanel).toBeVisible({ timeout: 10_000 });

    const tracesTab = resourcePanel.getByRole('tab', { name: 'Traces' });
    await tracesTab.click();

    // Wait for trace list to populate
    const traceList = resourcePanel.getByTestId('traces-trace-list');
    await expect(traceList).toBeVisible({ timeout: 30_000 });

    // Click the first trace
    const traceButton = traceList.getByRole('button').first();
    await expect(traceButton).toBeVisible({ timeout: 10_000 });
    await traceButton.click();

    // Verify span tree renders
    const spanTree = resourcePanel.getByTestId('traces-span-tree');
    await expect(spanTree).toBeVisible({ timeout: 10_000 });

    // Verify tree has at least one span row with a name
    const spanRows = spanTree.getByRole('button');
    await expect(spanRows.first()).toBeVisible();

    // Click a span to open log panel
    await spanRows.first().click();

    const logPanel = resourcePanel.getByTestId('traces-log-panel');
    await expect(logPanel).toBeVisible({ timeout: 5_000 });
  });
});
