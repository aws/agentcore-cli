import { randomUUID } from 'crypto';

/**
 * Generate a new session ID using UUID v4.
 */
export function generateSessionId(): string {
  return randomUUID();
}
