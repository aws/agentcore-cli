import { clearExitMessage, getExitMessage, setExitMessage } from '../exit-message.js';
import { afterEach, describe, expect, it } from 'vitest';

describe('exit-message', () => {
  afterEach(() => clearExitMessage());

  it('returns null when no message set', () => {
    expect(getExitMessage()).toBeNull();
  });

  it('stores and retrieves a message', () => {
    setExitMessage('Goodbye!');

    expect(getExitMessage()).toBe('Goodbye!');
  });

  it('clears the message', () => {
    setExitMessage('Bye');
    clearExitMessage();

    expect(getExitMessage()).toBeNull();
  });

  it('overwrites previous message', () => {
    setExitMessage('First');
    setExitMessage('Second');

    expect(getExitMessage()).toBe('Second');
  });
});
