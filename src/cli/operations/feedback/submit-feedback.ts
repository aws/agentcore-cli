import { ValidationError } from '../../../lib/errors/types';
import { PACKAGE_VERSION } from '../../constants';
import { fetchPresignedUrl, submitForm, uploadFileToS3 } from './aperture-client';
import { buildFeedbackPayload, buildUserAgent } from './build-payload';
import {
  ALLOWED_SCREENSHOT_EXTENSIONS,
  APERTURE_FORM_CATEGORY,
  APERTURE_FORM_NAME,
  APERTURE_FORM_VERSION,
  MAX_SCREENSHOT_BYTES,
} from './constants';
import type { FeedbackSubmissionResult, SubmitFeedbackInput } from './types';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Thrown for any user-supplied input the feedback command refuses to send to
 * Aperture (empty/oversized message, missing/oversized/wrong-type screenshot).
 * Extends the shared `ValidationError` so telemetry classifies it as a user
 * error rather than a service/client failure.
 */
export class FeedbackValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
  }
}

function contentTypeForExtension(ext: string): string {
  if (ext === '.png') return 'image/png';
  return 'image/jpeg';
}

export const FEEDBACK_MESSAGE_MAX_LENGTH = 1000;

/**
 * Synchronous message validator. Returns null when valid, an error message
 * string otherwise. Reused by the TUI hook so users see errors at input time
 * rather than after walking through consent.
 */
export function validateFeedbackMessage(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return 'Feedback message cannot be empty.';
  }
  if (trimmed.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
    return `Feedback message must be ${FEEDBACK_MESSAGE_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

function validateMessage(message: string): void {
  const error = validateFeedbackMessage(message);
  if (error) {
    throw new FeedbackValidationError(error);
  }
}

/**
 * Async screenshot validator that reads, size-checks, and extension-checks the
 * file. Returns null on success. Reused by the TUI hook so the user sees an
 * error on the path-input screen rather than after consent.
 */
export async function validateScreenshotPath(filePath: string): Promise<string | null> {
  try {
    await loadAndValidateScreenshot(filePath);
    return null;
  } catch (err) {
    if (err instanceof FeedbackValidationError) return err.message;
    throw err;
  }
}

interface LoadedScreenshot {
  buffer: Uint8Array;
  fileName: string;
  contentType: string;
  sha256Base64: string;
  size: number;
}

/**
 * Expand a leading `~` or `~/...` to the user's home directory. Node's fs APIs
 * don't expand tildes — the shell normally does — so users who quote a path
 * like `"~/Desktop/foo.png"` to preserve spaces hit ENOENT. This handles that.
 */
function expandTilde(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

async function loadAndValidateScreenshot(rawFilePath: string): Promise<LoadedScreenshot> {
  const filePath = expandTilde(rawFilePath);

  // Stat the path first so we can give a precise error for directories or
  // missing files, rather than letting the extension check mask them.
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new FeedbackValidationError(`Could not read screenshot at ${filePath}: ${reason}`);
  }
  if (stat.isDirectory()) {
    throw new FeedbackValidationError(`Screenshot path is a directory, not a file: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new FeedbackValidationError(`Screenshot path is not a regular file: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_SCREENSHOT_EXTENSIONS.includes(ext as (typeof ALLOWED_SCREENSHOT_EXTENSIONS)[number])) {
    throw new FeedbackValidationError(`Screenshot must be one of: ${ALLOWED_SCREENSHOT_EXTENSIONS.join(', ')}.`);
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new FeedbackValidationError(`Could not read screenshot at ${filePath}: ${reason}`);
  }

  if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
    const sizeMb = (buffer.byteLength / (1024 * 1024)).toFixed(1);
    throw new FeedbackValidationError(`Screenshot is ${sizeMb} MB; maximum allowed size is 100 MB.`);
  }

  return {
    buffer: new Uint8Array(buffer),
    fileName: path.basename(filePath),
    contentType: contentTypeForExtension(ext),
    sha256Base64: createHash('sha256').update(buffer).digest('base64'),
    size: buffer.byteLength,
  };
}

/**
 * The presigned URL's path is the actual S3 object key. The form payload
 * must reference exactly that key — fabricating one client-side risks
 * pointing at an object that doesn't exist if Aperture's bucket layout,
 * region, or naming convention shifts.
 */
function objectKeyFromPresignedUrl(presignedUrl: string): string {
  const url = new URL(presignedUrl);
  return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
}

export async function submitFeedback(input: SubmitFeedbackInput): Promise<FeedbackSubmissionResult> {
  validateMessage(input.message);

  const userAgent = buildUserAgent(PACKAGE_VERSION);
  let screenshotReference: string | undefined;

  if (input.screenshot) {
    const file = await loadAndValidateScreenshot(input.screenshot.path);
    const presignedUrl = await fetchPresignedUrl(
      {
        category: APERTURE_FORM_CATEGORY,
        name: APERTURE_FORM_NAME,
        version: APERTURE_FORM_VERSION,
        fileName: file.fileName,
        fileSize: file.size,
        uploadFileSHA256: file.sha256Base64,
      },
      userAgent
    );
    await uploadFileToS3(presignedUrl, file.buffer, file.contentType, file.sha256Base64, userAgent);
    screenshotReference = objectKeyFromPresignedUrl(presignedUrl);
  }

  const payload = buildFeedbackPayload({
    message: input.message.trim(),
    screenshotReference,
    mode: input.mode,
  });

  const response = await submitForm(payload, userAgent);

  return {
    id: response.id,
    timestamp: response.timestamp,
    reference: response.reference,
  };
}
