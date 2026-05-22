import { APERTURE_INGESTION_URL, APERTURE_PRESIGNED_URL_ENDPOINT } from './constants';
import type { ApertureFormPayload, AperturePresignedUrlRequest, ApertureSubmitResponse } from './types';

export class ApertureError extends Error {
  status?: number;
  body?: string;

  constructor(message: string, opts: { status?: number; body?: string } = {}) {
    super(message);
    this.name = 'ApertureError';
    this.status = opts.status;
    this.body = opts.body;
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Fetches an S3 presigned URL for uploading a screenshot. Aperture returns the
 * URL as a plain text body, not JSON.
 */
export async function fetchPresignedUrl(request: AperturePresignedUrlRequest, userAgent: string): Promise<string> {
  const response = await fetch(APERTURE_PRESIGNED_URL_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await readBody(response);
    throw new ApertureError(`Failed to fetch screenshot upload URL (HTTP ${response.status}).`, {
      status: response.status,
      body,
    });
  }

  return (await response.text()).trim();
}

/**
 * Uploads a file to the presigned S3 URL. Aperture's bucket policy requires
 * the SHA-256 checksum headers and a tagging header that marks the upload as
 * not yet AV-scanned.
 */
export async function uploadFileToS3(
  presignedUrl: string,
  fileBuffer: Uint8Array,
  contentType: string,
  base64Sha256: string,
  userAgent: string
): Promise<void> {
  const response = await fetch(presignedUrl, {
    method: 'PUT',
    headers: {
      'content-type': contentType,
      'x-amz-checksum-algorithm': 'SHA256',
      'x-amz-checksum-sha256': base64Sha256,
      'x-amz-tagging': 'scanstatus=NOT_SCANNED',
      'user-agent': userAgent,
    },
    body: fileBuffer,
  });

  if (!response.ok) {
    const body = await readBody(response);
    throw new ApertureError(`Failed to upload screenshot (HTTP ${response.status}).`, {
      status: response.status,
      body,
    });
  }
}

export async function submitForm(payload: ApertureFormPayload, userAgent: string): Promise<ApertureSubmitResponse> {
  const response = await fetch(APERTURE_INGESTION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await readBody(response);
    throw new ApertureError(mapStatusToMessage(response.status, body), { status: response.status, body });
  }

  return (await response.json()) as ApertureSubmitResponse;
}

function mapStatusToMessage(status: number, body: string): string {
  switch (status) {
    case 400:
      return `Feedback service rejected the submission (HTTP 400). ${body || 'Form payload may be malformed.'}`;
    case 412:
      return 'Feedback service is missing required headers (HTTP 412).';
    case 417:
      return 'Feedback service rejected the request content type (HTTP 417).';
    case 500:
      return 'Feedback service returned an internal error (HTTP 500). Please try again later.';
    default:
      return `Feedback service returned HTTP ${status}.`;
  }
}
