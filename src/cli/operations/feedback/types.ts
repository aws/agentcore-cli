export interface ApertureMetadata {
  key: string;
  value: string;
}

export interface ApertureTextResponse {
  question: string;
  pii: boolean;
  response: {
    responseType: 'textArea' | 'text';
    responseValue: string;
  };
}

export interface ApertureFileUploadResponse {
  question: string;
  pii: boolean;
  response: {
    responseType: 'fileUpload';
    responseValue: string[];
  };
}

export type ApertureCustomerResponse = ApertureTextResponse | ApertureFileUploadResponse;

export interface ApertureFormPayload {
  category: string;
  name: string;
  version: string;
  locale: string;
  reference?: string;
  location?: string;
  customerResponses: ApertureCustomerResponse[];
  metadataList: ApertureMetadata[];
}

export type FeedbackMode = 'cli' | 'tui';

export interface SubmissionContext {
  mode: FeedbackMode;
}

export interface AperturePresignedUrlRequest {
  category: string;
  name: string;
  version: string;
  fileName: string;
  fileSize: number;
  uploadFileSHA256: string;
}

export interface ApertureSubmitResponse {
  reference: string;
  id: string;
  timestamp: string;
}

export interface FeedbackSubmissionResult {
  id: string;
  timestamp: string;
  reference: string;
}

export interface ScreenshotInput {
  path: string;
}

export interface SubmitFeedbackInput {
  message: string;
  screenshot?: ScreenshotInput;
  mode?: FeedbackMode;
}
