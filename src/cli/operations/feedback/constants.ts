export const APERTURE_FORM_CATEGORY = 'AgentCore';
export const APERTURE_FORM_NAME = 'CLI';
export const APERTURE_FORM_VERSION = '0.1.0';
export const APERTURE_LOCALE = 'en_US';

export const APERTURE_INGESTION_URL = 'https://ingestion.aperture-public-api.feedback.console.aws.dev/form';
export const APERTURE_PRESIGNED_URL_ENDPOINT =
  'https://presignedurl.aperture-public-api.feedback.console.aws.dev/presignedurl';

export const MAX_SCREENSHOT_BYTES = 100 * 1024 * 1024;
export const ALLOWED_SCREENSHOT_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

export const FEEDBACK_MESSAGE_QUESTION = 'What feedback do you have for the AgentCore CLI';
export const FEEDBACK_ATTACHMENT_QUESTION = 'Attachments';
export const METADATA_KEY_CLI_VERSION = 'cli-version';
export const METADATA_KEY_OS = 'os';

export const FEEDBACK_REFERENCE = 'agentcore-cli';

export const CONSENT_TEXT =
  'All feedback submissions, including any uploaded text and images, are subject ' +
  'to the AWS Customer Agreement (https://aws.amazon.com/agreement/). By submitting ' +
  'feedback, you agree that your submissions constitute "Suggestions" as defined ' +
  'in the AWS Customer Agreement.';
