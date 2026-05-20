import { buildFeedbackPayload } from '../build-payload';
import { describe, expect, it } from 'vitest';

describe('buildFeedbackPayload', () => {
  it('emits the message-only payload when no screenshot is supplied', () => {
    const payload = buildFeedbackPayload({
      message: 'CLI ate my homework',
      cliVersion: '0.1.0-alpha.42',
      osDescriptor: 'darwin 25.3.0',
      mode: 'cli',
    });

    expect(payload.category).toBe('AgentCore');
    expect(payload.name).toBe('CLI');
    expect(payload.version).toBe('0.1.0');
    expect(payload.locale).toBe('en_US');
    expect(payload.reference).toBe('agentcore-cli');
    expect(payload.location).toContain('agentcore-cli@0.1.0-alpha.42');
    expect(payload.location).toContain('cli');
    expect(payload.customerResponses).toHaveLength(1);
    expect(payload.customerResponses[0]).toMatchObject({
      question: 'What feedback do you have for the AgentCore CLI',
      pii: false,
      response: { responseType: 'textArea', responseValue: 'CLI ate my homework' },
    });
    // Aperture form template only registers `cli-version` and `os`. Other
    // context (node version, mode) lives in `location` until the template
    // adds those keys; sending unknown metadata keys is a hard 400.
    expect(payload.metadataList).toEqual([
      { key: 'cli-version', value: '0.1.0-alpha.42' },
      { key: 'os', value: 'darwin 25.3.0' },
    ]);
  });

  it('appends a fileUpload response when a screenshot reference is supplied', () => {
    const payload = buildFeedbackPayload({
      message: 'broken icon',
      screenshotReference: 'https://s3.example.com/bucket/key.png',
      cliVersion: '0.1.0',
      osDescriptor: 'linux 6.0 node v20',
    });

    expect(payload.customerResponses).toHaveLength(2);
    const attachment = payload.customerResponses[1];
    expect(attachment).toMatchObject({
      question: 'Attachments',
      pii: true,
      response: {
        responseType: 'fileUpload',
        responseValue: ['https://s3.example.com/bucket/key.png'],
      },
    });
  });
});
