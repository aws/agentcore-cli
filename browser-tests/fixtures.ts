import { ENV_FILE } from './constants';
import { type Page, test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

interface BrowserTestEnv {
  projectPath: string;
  port: number;
  projectName: string;
}

function readTestEnv(): BrowserTestEnv {
  const raw = readFileSync(ENV_FILE, 'utf-8');
  const parsed: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match) parsed[match[1]!] = match[2]!;
  }
  return {
    projectPath: parsed.PROJECT_PATH!,
    port: Number(parsed.PORT),
    projectName: parsed.PROJECT_NAME!,
  };
}

export const test = base.extend<{ testEnv: BrowserTestEnv }>({
  testEnv: async ({}, use) => {
    await use(readTestEnv());
  },
});

/**
 * Send a chat message and wait for the agent to finish responding.
 * Returns the assistant message locator.
 */
export async function sendMessage(page: Page, text: string) {
  const chatInput = page.getByTestId('chat-input');
  await expect(chatInput).toBeEnabled({ timeout: 60_000 });

  const messageList = page.getByTestId('message-list');
  const existingCount = await messageList.getByTestId(/^chat-message-/).count();

  await chatInput.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();

  const assistantMessage = messageList.getByTestId(`chat-message-${existingCount + 1}`);
  await expect(assistantMessage).toBeVisible({ timeout: 60_000 });
  await expect(assistantMessage).not.toContainText('ECONNREFUSED');

  // Wait for streaming to complete so the agent is idle for subsequent tests.
  await chatInput.fill('.');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled({ timeout: 30_000 });

  return assistantMessage;
}

export { expect };
