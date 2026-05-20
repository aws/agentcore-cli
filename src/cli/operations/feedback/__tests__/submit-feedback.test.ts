import { FeedbackValidationError, submitFeedback } from '../submit-feedback';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const successResponse = {
  reference: 'S3',
  id: 'submission-123',
  timestamp: '2026-05-13T18:00:00Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyOk(status = 200): Response {
  return new Response('', { status });
}

type FetchCall = [string, { method: string; headers: Record<string, string>; body: string | Uint8Array }];

describe('submitFeedback', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function callAt(index: number): FetchCall {
    const all = fetchMock.mock.calls as unknown as FetchCall[];
    const call = all[index];
    if (!call) throw new Error(`Expected fetch call ${index}, only saw ${all.length}`);
    return call;
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects empty messages without making any network call', async () => {
    await expect(submitFeedback({ message: '   ' })).rejects.toBeInstanceOf(FeedbackValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits a message-only form to the ingestion endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(successResponse));

    const result = await submitFeedback({ message: 'looks great' });

    expect(result).toEqual({
      id: 'submission-123',
      timestamp: '2026-05-13T18:00:00Z',
      reference: 'S3',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = callAt(0);
    expect(url).toBe('https://ingestion.aperture-public-api.feedback.console.aws.dev/form');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.customerResponses).toHaveLength(1);
    expect(body.customerResponses[0].response.responseValue).toBe('looks great');
  });

  it('uploads a screenshot via presigned URL before submitting the form', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-test-'));
    const screenshotPath = path.join(tmp, 'shot.png');
    await fs.writeFile(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    fetchMock
      .mockResolvedValueOnce(
        new Response('https://s3.example/us-east-1/AgentCore/CLI/0.1.0/13052026/abc-123.png?sig=x', { status: 200 })
      )
      .mockResolvedValueOnce(emptyOk(200))
      .mockResolvedValueOnce(jsonResponse(successResponse));

    const result = await submitFeedback({
      message: 'see screenshot',
      screenshot: { path: screenshotPath },
    });

    expect(result.id).toBe('submission-123');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [presignUrl, presignInit] = callAt(0);
    expect(presignUrl).toBe('https://presignedurl.aperture-public-api.feedback.console.aws.dev/presignedurl');
    const presignBody = JSON.parse(presignInit.body as string);
    expect(presignBody).toMatchObject({
      category: 'AgentCore',
      name: 'CLI',
      version: '0.1.0',
      fileName: 'shot.png',
      fileSize: 4,
    });
    expect(typeof presignBody.uploadFileSHA256).toBe('string');
    // base64 sha256 length for any input is 44 chars
    expect(presignBody.uploadFileSHA256).toHaveLength(44);

    const [uploadUrl, uploadInit] = callAt(1);
    expect(uploadUrl).toBe('https://s3.example/us-east-1/AgentCore/CLI/0.1.0/13052026/abc-123.png?sig=x');
    expect(uploadInit.method).toBe('PUT');
    expect(uploadInit.headers['content-type']).toBe('image/png');
    expect(uploadInit.headers['x-amz-checksum-algorithm']).toBe('SHA256');
    expect(uploadInit.headers['x-amz-checksum-sha256']).toBe(presignBody.uploadFileSHA256);
    expect(uploadInit.headers['x-amz-tagging']).toBe('scanstatus=NOT_SCANNED');

    const [, submitInit] = callAt(2);
    const submitBody = JSON.parse(submitInit.body as string);
    expect(submitBody.customerResponses).toHaveLength(2);
    expect(submitBody.customerResponses[1]).toMatchObject({
      question: 'Attachments',
      pii: true,
      response: { responseType: 'fileUpload' },
    });
    // Reference must be the actual S3 key parsed from the presigned URL path,
    // not a key fabricated client-side.
    const responseValue = submitBody.customerResponses[1].response.responseValue;
    expect(Array.isArray(responseValue)).toBe(true);
    expect(responseValue[0]).toBe('us-east-1/AgentCore/CLI/0.1.0/13052026/abc-123.png');

    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('rejects screenshots with disallowed extensions before any network call', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-test-'));
    const gifPath = path.join(tmp, 'shot.gif');
    await fs.writeFile(gifPath, 'data');

    await expect(submitFeedback({ message: 'msg', screenshot: { path: gifPath } })).rejects.toBeInstanceOf(
      FeedbackValidationError
    );

    expect(fetchMock).not.toHaveBeenCalled();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reports a clear error when the screenshot file is missing', async () => {
    await expect(submitFeedback({ message: 'msg', screenshot: { path: '/no/such/file.png' } })).rejects.toThrow(
      /Could not read screenshot/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a directory with a directory-specific error, not the extension error', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-test-'));
    await expect(submitFeedback({ message: 'msg', screenshot: { path: tmp } })).rejects.toThrow(
      /is a directory, not a file/
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('expands a leading tilde so quoted paths like "~/file.png" resolve', async () => {
    // Drop a real file in $HOME so tilde-expansion has somewhere to land
    const fileName = `feedback-tilde-${Date.now()}.png`;
    const realPath = path.join(os.homedir(), fileName);
    await fs.writeFile(realPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    fetchMock
      .mockResolvedValueOnce(new Response('https://s3.example/key?sig=x', { status: 200 }))
      .mockResolvedValueOnce(emptyOk(200))
      .mockResolvedValueOnce(jsonResponse(successResponse));

    const result = await submitFeedback({ message: 'tilde', screenshot: { path: `~/${fileName}` } });
    expect(result.id).toBe('submission-123');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await fs.rm(realPath, { force: true });
  });

  it('maps Aperture 412 responses to a missing-headers error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('missing headers', { status: 412 }));

    await expect(submitFeedback({ message: 'msg' })).rejects.toThrow(/HTTP 412/);
  });

  it('maps Aperture 500 responses to a retryable error message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    await expect(submitFeedback({ message: 'msg' })).rejects.toThrow(/HTTP 500/);
  });
});
