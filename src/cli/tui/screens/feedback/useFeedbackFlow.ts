import { submitFeedback, validateFeedbackMessage, validateScreenshotPath } from '../../../operations/feedback';
import type { FeedbackSubmissionResult } from '../../../operations/feedback';
import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run';
import { useCallback, useEffect, useRef, useState } from 'react';

export type FeedbackPhase =
  | 'message'
  | 'screenshot-prompt'
  | 'screenshot-path'
  | 'consent'
  | 'submitting'
  | 'success'
  | 'error';

export interface FeedbackState {
  phase: FeedbackPhase;
  message: string;
  screenshotPath?: string;
  result?: FeedbackSubmissionResult;
  /** Submission failure detail, shown on the 'error' phase. */
  error?: string;
  /** Inline validation error shown on the current input phase. */
  inputError?: string;
}

export interface UseFeedbackFlowOptions {
  initialScreenshot?: string;
  onSubmit?: typeof submitFeedback;
  validateMessage?: typeof validateFeedbackMessage;
  validateScreenshot?: typeof validateScreenshotPath;
}

export function useFeedbackFlow(options: UseFeedbackFlowOptions = {}) {
  const onSubmit = options.onSubmit ?? submitFeedback;
  const validateMessage = options.validateMessage ?? validateFeedbackMessage;
  const validateScreenshot = options.validateScreenshot ?? validateScreenshotPath;

  const [state, setState] = useState<FeedbackState>({
    phase: 'message',
    message: '',
    screenshotPath: options.initialScreenshot,
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setMessage = useCallback(
    (message: string) => {
      const validationError = validateMessage(message);
      if (validationError) {
        setState(prev => ({ ...prev, message, inputError: validationError }));
        return;
      }
      setState(prev => ({ ...prev, message, phase: 'screenshot-prompt', inputError: undefined }));
    },
    [validateMessage]
  );

  const chooseAttachScreenshot = useCallback(() => {
    setState(prev => ({ ...prev, phase: 'screenshot-path', inputError: undefined }));
  }, []);

  const skipScreenshot = useCallback(() => {
    setState(prev => ({ ...prev, screenshotPath: undefined, phase: 'consent', inputError: undefined }));
  }, []);

  const setScreenshot = useCallback(
    async (screenshotPath: string | undefined) => {
      const normalized = screenshotPath && screenshotPath.length > 0 ? screenshotPath : undefined;
      if (!normalized) {
        setState(prev => ({ ...prev, screenshotPath: undefined, phase: 'consent', inputError: undefined }));
        return;
      }
      const validationError = await validateScreenshot(normalized);
      if (!mountedRef.current) return;
      if (validationError) {
        setState(prev => ({ ...prev, screenshotPath: normalized, inputError: validationError }));
        return;
      }
      setState(prev => ({ ...prev, screenshotPath: normalized, phase: 'consent', inputError: undefined }));
    },
    [validateScreenshot]
  );

  const performSubmit = useCallback(async () => {
    setState(prev => ({ ...prev, phase: 'submitting', error: undefined }));
    const has_screenshot = !!state.screenshotPath;
    const result = await withCommandRunTelemetry(
      'feedback',
      { mode: 'tui', has_screenshot },
      async (): Promise<{ success: true; submission: FeedbackSubmissionResult } | { success: false; error: Error }> => {
        try {
          const submission = await onSubmit({
            message: state.message,
            screenshot: state.screenshotPath ? { path: state.screenshotPath } : undefined,
            mode: 'tui',
          });
          return { success: true, submission };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
        }
      }
    );

    if (!mountedRef.current) return;
    if (result.success) {
      setState(prev => ({ ...prev, phase: 'success', result: result.submission }));
    } else {
      setState(prev => ({ ...prev, phase: 'error', error: result.error.message }));
    }
  }, [onSubmit, state.message, state.screenshotPath]);

  const confirmConsent = useCallback(() => {
    void performSubmit();
  }, [performSubmit]);

  const declineConsent = useCallback(() => {
    setState(prev => ({ ...prev, phase: 'message' }));
  }, []);

  const goBack = useCallback(() => {
    setState(prev => {
      switch (prev.phase) {
        case 'screenshot-prompt':
          return { ...prev, phase: 'message', inputError: undefined };
        case 'screenshot-path':
          return { ...prev, phase: 'screenshot-prompt', inputError: undefined };
        case 'consent':
          return { ...prev, phase: 'screenshot-prompt', inputError: undefined };
        case 'error':
          return { ...prev, phase: 'consent', error: undefined };
        default:
          return prev;
      }
    });
  }, []);

  const retry = useCallback(() => {
    void performSubmit();
  }, [performSubmit]);

  return {
    state,
    setMessage,
    chooseAttachScreenshot,
    skipScreenshot,
    setScreenshot,
    confirmConsent,
    declineConsent,
    goBack,
    retry,
  };
}
