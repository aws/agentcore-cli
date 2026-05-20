import { submitFeedback } from '../../../operations/feedback';
import type { FeedbackSubmissionResult } from '../../../operations/feedback';
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
  error?: string;
}

export interface UseFeedbackFlowOptions {
  initialScreenshot?: string;
  onSubmit?: typeof submitFeedback;
}

export function useFeedbackFlow(options: UseFeedbackFlowOptions = {}) {
  const onSubmit = options.onSubmit ?? submitFeedback;

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

  const setMessage = useCallback((message: string) => {
    setState(prev => ({ ...prev, message, phase: 'screenshot-prompt' }));
  }, []);

  const chooseAttachScreenshot = useCallback(() => {
    setState(prev => ({ ...prev, phase: 'screenshot-path' }));
  }, []);

  const skipScreenshot = useCallback(() => {
    setState(prev => ({ ...prev, screenshotPath: undefined, phase: 'consent' }));
  }, []);

  const setScreenshot = useCallback((screenshotPath: string | undefined) => {
    const normalized = screenshotPath && screenshotPath.length > 0 ? screenshotPath : undefined;
    if (!normalized) {
      setState(prev => ({ ...prev, screenshotPath: undefined, phase: 'consent' }));
      return;
    }
    setState(prev => ({ ...prev, screenshotPath: normalized, phase: 'consent' }));
  }, []);

  const performSubmit = useCallback(async () => {
    setState(prev => ({ ...prev, phase: 'submitting', error: undefined }));
    try {
      const result = await onSubmit({
        message: state.message,
        screenshot: state.screenshotPath ? { path: state.screenshotPath } : undefined,
        mode: 'tui',
      });
      if (!mountedRef.current) return;
      setState(prev => ({ ...prev, phase: 'success', result }));
    } catch (err) {
      if (!mountedRef.current) return;
      const error = err instanceof Error ? err.message : String(err);
      setState(prev => ({ ...prev, phase: 'error', error }));
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
          return { ...prev, phase: 'message' };
        case 'screenshot-path':
          return { ...prev, phase: 'screenshot-prompt' };
        case 'consent':
          return { ...prev, phase: 'screenshot-prompt' };
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
