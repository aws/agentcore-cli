import { CONSENT_TEXT } from '../../operations/feedback/constants';
import * as readline from 'node:readline/promises';

const PROMPT_LINE = 'Submit feedback? [y/N] ';

export interface ConsentPromptDeps {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout?: NodeJS.WritableStream;
}

export interface ConsentPromptResult {
  accepted: boolean;
  reason?: 'declined' | 'no-tty';
}

/**
 * Renders the AWS Customer Agreement consent text and reads y/N from the
 * interactive terminal. Defaults to "no" on bare Enter; refuses to read
 * non-TTY stdin so the consent decision is always explicit.
 */
export async function promptForConsent(deps: ConsentPromptDeps = {}): Promise<ConsentPromptResult> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;

  if (!stdin.isTTY) {
    return { accepted: false, reason: 'no-tty' };
  }

  stdout.write(`\n${CONSENT_TEXT}\n\n`);

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(PROMPT_LINE)).trim().toLowerCase();
    const accepted = answer === 'y' || answer === 'yes';
    return { accepted, reason: accepted ? undefined : 'declined' };
  } finally {
    rl.close();
  }
}
