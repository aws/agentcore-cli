import { PACKAGE_VERSION } from '../../constants';
import { fetchPresignedUrl, submitForm, uploadFileToS3 } from './aperture-client';
import { buildFeedbackPayload, buildUserAgent } from './build-payload';
import {
  ALLOWED_SCREENSHOT_EXTENSIONS,
  APERTURE_FORM_CATEGORY,
  APERTURE_FORM_NAME,
  APERTURE_FORM_VERSION,
  APERTURE_S3_REGION,
  MAX_SCREENSHOT_BYTES,
} from './constants';
import type { FeedbackSubmissionResult, SubmitFeedbackInput } from './types';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class FeedbackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackValidationError';
  }
}

function contentTypeForExtension(ext: string): string {
  if (ext === '.png') return 'image/png';
  return 'image/jpeg';
}

function validateMessage(message: string): void {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new FeedbackValidationError('Feedback message cannot be empty.');
  }
  if (trimmed.length > 1000) {
    throw new FeedbackValidationError('Feedback message must be 1000 characters or fewer.');
  }
}

interface LoadedScreenshot {
  buffer: Uint8Array;
  fileName: string;
  extension: string;
  contentType: string;
  sha256Base64: string;
  size: number;
}

async function loadAndValidateScreenshot(filePath: string): Promise<LoadedScreenshot> {
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
    extension: ext.replace(/^\./, ''),
    contentType: contentTypeForExtension(ext),
    sha256Base64: createHash('sha256').update(buffer).digest('base64'),
    size: buffer.byteLength,
  };
}

function buildAttachmentObjectKey(extension: string, now = new Date()): string {
  const day = now.getUTCDate().toString().padStart(2, '0');
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const year = now.getUTCFullYear().toString();
  const datePart = `${day}${month}${year}`;
  return `${APERTURE_S3_REGION}/${APERTURE_FORM_CATEGORY}/${APERTURE_FORM_NAME}/${APERTURE_FORM_VERSION}/${datePart}/${randomUUID()}.${extension}`;
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
    screenshotReference = buildAttachmentObjectKey(file.extension);
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
