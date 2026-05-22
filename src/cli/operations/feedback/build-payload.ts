import { PACKAGE_VERSION } from '../../constants';
import {
  APERTURE_FORM_CATEGORY,
  APERTURE_FORM_NAME,
  APERTURE_FORM_VERSION,
  APERTURE_LOCALE,
  FEEDBACK_ATTACHMENT_QUESTION,
  FEEDBACK_MESSAGE_QUESTION,
  FEEDBACK_REFERENCE,
  METADATA_KEY_CLI_VERSION,
  METADATA_KEY_OS,
} from './constants';
import type { ApertureCustomerResponse, ApertureFormPayload, ApertureMetadata, FeedbackMode } from './types';
import * as os from 'node:os';

interface BuildPayloadInput {
  message: string;
  screenshotReference?: string;
  mode?: FeedbackMode;
  cliVersion?: string;
  osDescriptor?: string;
}

export function buildOsDescriptor(): string {
  return `${process.platform} ${os.release()}`;
}

export function buildLocationDescriptor(cliVersion: string, mode: FeedbackMode): string {
  return `agentcore-cli@${cliVersion} (${process.platform}; node ${process.version}; ${mode})`;
}

export function buildUserAgent(cliVersion: string): string {
  return `AgentCoreCLI/${cliVersion} (${process.platform} ${os.release()}; node/${process.version})`;
}

export function buildFeedbackPayload(input: BuildPayloadInput): ApertureFormPayload {
  const cliVersion = input.cliVersion ?? PACKAGE_VERSION;
  const osDescriptor = input.osDescriptor ?? buildOsDescriptor();
  const mode: FeedbackMode = input.mode ?? 'cli';

  const customerResponses: ApertureCustomerResponse[] = [
    {
      question: FEEDBACK_MESSAGE_QUESTION,
      pii: false,
      response: {
        responseType: 'textArea',
        responseValue: input.message,
      },
    },
  ];

  if (input.screenshotReference) {
    customerResponses.push({
      question: FEEDBACK_ATTACHMENT_QUESTION,
      pii: true,
      response: {
        responseType: 'fileUpload',
        responseValue: [input.screenshotReference],
      },
    });
  }

  // Aperture validates metadata keys against the published form template; sending unknown
  // keys is rejected with HTTP 400. Only `cli-version` and `os` are registered today.
  // node-version and cli-mode are encoded into `location` until the template is updated.
  const metadataList: ApertureMetadata[] = [
    { key: METADATA_KEY_CLI_VERSION, value: cliVersion },
    { key: METADATA_KEY_OS, value: osDescriptor },
  ];

  return {
    category: APERTURE_FORM_CATEGORY,
    name: APERTURE_FORM_NAME,
    version: APERTURE_FORM_VERSION,
    locale: APERTURE_LOCALE,
    reference: FEEDBACK_REFERENCE,
    location: buildLocationDescriptor(cliVersion, mode),
    customerResponses,
    metadataList,
  };
}
