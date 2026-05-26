import { promptForConsent } from '../consent-prompt';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

function makeTtyStdin(input: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
  stream.isTTY = true;
  stream.end(input);
  return stream;
}

describe('promptForConsent', () => {
  it('returns no-tty when stdin is not a TTY', async () => {
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = false;
    const stdout = new PassThrough();

    const result = await promptForConsent({ stdin, stdout });

    expect(result).toEqual({ accepted: false, reason: 'no-tty' });
  });

  it('accepts when the user types y', async () => {
    const stdin = makeTtyStdin('y\n');
    const stdout = new PassThrough();
    stdout.resume();

    const result = await promptForConsent({ stdin, stdout });

    expect(result.accepted).toBe(true);
  });

  it('declines on bare Enter (defaults to No)', async () => {
    const stdin = makeTtyStdin('\n');
    const stdout = new PassThrough();
    stdout.resume();

    const result = await promptForConsent({ stdin, stdout });

    expect(result).toEqual({ accepted: false, reason: 'declined' });
  });

  it('declines when the user types n', async () => {
    const stdin = makeTtyStdin('n\n');
    const stdout = new PassThrough();
    stdout.resume();

    const result = await promptForConsent({ stdin, stdout });

    expect(result).toEqual({ accepted: false, reason: 'declined' });
  });
});
