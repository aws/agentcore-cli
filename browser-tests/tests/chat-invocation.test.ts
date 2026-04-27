import { expect, sendMessage, test } from '../fixtures';

test.describe('Chat invocation', () => {
  test('send a message and receive a response', async ({ page }) => {
    await page.goto('/');

    const assistantMessage = await sendMessage(page, 'What is 2 plus 2? Reply with just the number.');
    await expect(assistantMessage).not.toBeEmpty();
  });
});
