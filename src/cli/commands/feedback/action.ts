import { toError } from '../../../lib/errors/types';
import { submitFeedback } from '../../operations/feedback';
import type { FeedbackSubmissionResult } from '../../operations/feedback';
import { promptForConsent } from './consent-prompt';
import type { FeedbackOptions } from './types';

export type FeedbackOutcome =
  | { kind: 'submitted'; result: FeedbackSubmissionResult }
  | { kind: 'declined' }
  | { kind: 'no-tty' }
  | { kind: 'error'; error: Error };

export async function handleFeedback(message: string, options: FeedbackOptions): Promise<FeedbackOutcome> {
  const consent = await promptForConsent();
  if (!consent.accepted) {
    return consent.reason === 'no-tty' ? { kind: 'no-tty' } : { kind: 'declined' };
  }

  try {
    const result = await submitFeedback({
      message,
      screenshot: options.screenshot ? { path: options.screenshot } : undefined,
      mode: 'cli',
    });
    return { kind: 'submitted', result };
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  }
}
