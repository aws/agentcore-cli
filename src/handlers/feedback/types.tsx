export type ScreenshotInput = { path: string };

export type SubmitFeedbackInput = {
  message: string;
  screenshot?: ScreenshotInput;
};

export type FeedbackSubmissionResult = {
  id: string;
  timestamp: string;
  reference: string;
};
