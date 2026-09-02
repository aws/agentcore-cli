import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentCoreCLIError, ERROR_SOURCE, InputValidationError } from "../../errors";
import { PACKAGE_VERSION } from "../../constants";
import type { CoreFetch } from "../../core/types";
import type { FeedbackSubmissionResult, SubmitFeedbackInput } from "./types";

const INGESTION_URL = "https://ingestion.aperture-public-api.feedback.console.aws.dev/form";
const PRESIGN_URL =
  "https://presignedurl.aperture-public-api.feedback.console.aws.dev/presignedurl";
const FORM_CATEGORY = "AgentCore";
const FORM_NAME = "CLI";
const FORM_VERSION = "0.1.0";
const LOCALE = "en_US";
const REFERENCE = "agentcore-cli";
const MESSAGE_QUESTION = "What feedback do you have for the AgentCore CLI";
const ATTACHMENT_QUESTION = "Attachments";
const MESSAGE_MAX_LENGTH = 1000;
const MAX_SCREENSHOT_BYTES = 100 * 1024 * 1024;
const ALLOWED_SCREENSHOT_EXTENSIONS = [".png", ".jpg", ".jpeg"] as const;

export const CONSENT_TEXT =
  "All feedback submissions, including any uploaded text and images, are subject " +
  "to the AWS Customer Agreement (https://aws.amazon.com/agreement/). By submitting " +
  'feedback, you agree that your submissions constitute "Suggestions" as defined ' +
  "in the AWS Customer Agreement.";

export class ApertureError extends AgentCoreCLIError {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message, { source: ERROR_SOURCE.SERVICE, name: "ApertureError" });
  }
}

type LoadedScreenshot = {
  buffer: Uint8Array;
  fileName: string;
  contentType: string;
  sha256Base64: string;
  size: number;
};

type ApertureCustomerResponse = {
  question: string;
  pii: boolean;
  response:
    | { responseType: "textArea"; responseValue: string }
    | { responseType: "fileUpload"; responseValue: string[] };
};

type ApertureFormPayload = {
  category: string;
  name: string;
  version: string;
  locale: string;
  reference: string;
  location: string;
  customerResponses: ApertureCustomerResponse[];
  metadataList: { key: string; value: string }[];
};

export async function submitFeedback(
  input: SubmitFeedbackInput,
  fetch: CoreFetch,
): Promise<FeedbackSubmissionResult> {
  const message = input.message.trim();
  if (!message) {
    throw new InputValidationError("Feedback message cannot be empty.");
  }
  if (message.length > MESSAGE_MAX_LENGTH) {
    throw new InputValidationError(
      `Feedback message must be ${MESSAGE_MAX_LENGTH} characters or fewer.`,
    );
  }

  const userAgent = `AgentCoreCLI/${PACKAGE_VERSION} (${process.platform} ${os.release()}; node/${process.version})`;

  let screenshotReference: string | undefined;
  if (input.screenshot) {
    const file = await loadScreenshot(input.screenshot.path);
    const presignedUrl = await fetchPresignedUrl(
      fetch,
      {
        category: FORM_CATEGORY,
        name: FORM_NAME,
        version: FORM_VERSION,
        fileName: file.fileName,
        fileSize: file.size,
        uploadFileSHA256: file.sha256Base64,
      },
      userAgent,
    );
    screenshotReference = objectKeyFromPresignedUrl(presignedUrl);
    await uploadFileToS3(
      fetch,
      presignedUrl,
      file.buffer,
      file.contentType,
      file.sha256Base64,
      userAgent,
    );
  }

  const payload = buildFeedbackPayload({ message, screenshotReference });
  return submitForm(fetch, payload, userAgent);
}

async function fetchPresignedUrl(
  fetch: CoreFetch,
  request: {
    category: string;
    name: string;
    version: string;
    fileName: string;
    fileSize: number;
    uploadFileSHA256: string;
  },
  userAgent: string,
): Promise<string> {
  const response = await fetch(PRESIGN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new ApertureError(
      `Failed to fetch screenshot upload URL (HTTP ${response.status}).`,
      response.status,
      await response.text().catch(() => ""),
    );
  }
  return (await response.text()).trim();
}

async function uploadFileToS3(
  fetch: CoreFetch,
  presignedUrl: string,
  fileBuffer: Uint8Array,
  contentType: string,
  base64Sha256: string,
  userAgent: string,
): Promise<void> {
  const response = await fetch(presignedUrl, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      "x-amz-checksum-algorithm": "SHA256",
      "x-amz-checksum-sha256": base64Sha256,
      "x-amz-tagging": "scanstatus=NOT_SCANNED",
      "user-agent": userAgent,
    },
    body: fileBuffer,
  });
  if (!response.ok) {
    throw new ApertureError(
      `Failed to upload screenshot (HTTP ${response.status}).`,
      response.status,
      await response.text().catch(() => ""),
    );
  }
}

async function submitForm(
  fetch: CoreFetch,
  payload: ApertureFormPayload,
  userAgent: string,
): Promise<FeedbackSubmissionResult> {
  const response = await fetch(INGESTION_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApertureError(mapStatusToMessage(response.status, body), response.status, body);
  }
  const data = (await response
    .json()
    .catch(() => null)) as Partial<FeedbackSubmissionResult> | null;
  if (
    !data ||
    typeof data.id !== "string" ||
    typeof data.timestamp !== "string" ||
    typeof data.reference !== "string"
  ) {
    throw new ApertureError("Feedback service returned an unexpected response.");
  }
  return { id: data.id, timestamp: data.timestamp, reference: data.reference };
}

async function loadScreenshot(rawFilePath: string): Promise<LoadedScreenshot> {
  const filePath = expandTilde(rawFilePath);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch (err) {
    throw new InputValidationError(
      `Could not read screenshot at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (stats.isDirectory()) {
    throw new InputValidationError(`Screenshot path is a directory, not a file: ${filePath}`);
  }
  if (!stats.isFile()) {
    throw new InputValidationError(`Screenshot path is not a regular file: ${filePath}`);
  }
  if (stats.size > MAX_SCREENSHOT_BYTES) {
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
    throw new InputValidationError(`Screenshot is ${sizeMb} MB; maximum allowed size is 100 MB.`);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (
    !ALLOWED_SCREENSHOT_EXTENSIONS.includes(ext as (typeof ALLOWED_SCREENSHOT_EXTENSIONS)[number])
  ) {
    throw new InputValidationError(
      `Screenshot must be one of: ${ALLOWED_SCREENSHOT_EXTENSIONS.join(", ")}.`,
    );
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (err) {
    throw new InputValidationError(
      `Could not read screenshot at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    buffer: new Uint8Array(buffer),
    fileName: path.basename(filePath),
    contentType: ext === ".png" ? "image/png" : "image/jpeg",
    sha256Base64: createHash("sha256").update(buffer).digest("base64"),
    size: buffer.byteLength,
  };
}

function expandTilde(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function objectKeyFromPresignedUrl(presignedUrl: string): string {
  try {
    return decodeURIComponent(new URL(presignedUrl).pathname.replace(/^\/+/, ""));
  } catch {
    throw new ApertureError("Feedback service returned an invalid screenshot upload URL.");
  }
}

function buildFeedbackPayload(input: {
  message: string;
  screenshotReference?: string;
}): ApertureFormPayload {
  const customerResponses: ApertureCustomerResponse[] = [
    {
      question: MESSAGE_QUESTION,
      pii: false,
      response: { responseType: "textArea", responseValue: input.message },
    },
  ];
  if (input.screenshotReference) {
    customerResponses.push({
      question: ATTACHMENT_QUESTION,
      pii: true,
      response: { responseType: "fileUpload", responseValue: [input.screenshotReference] },
    });
  }

  return {
    category: FORM_CATEGORY,
    name: FORM_NAME,
    version: FORM_VERSION,
    locale: LOCALE,
    reference: REFERENCE,
    location: `agentcore-cli@${PACKAGE_VERSION} (${process.platform}; node ${process.version}; cli)`,
    customerResponses,
    metadataList: [
      { key: "cli-version", value: PACKAGE_VERSION },
      { key: "os", value: `${process.platform} ${os.release()}` },
    ],
  };
}

function mapStatusToMessage(status: number, body: string): string {
  switch (status) {
    case 400:
      return `Feedback service rejected the submission (HTTP 400). ${body || "Form payload may be malformed."}`;
    case 412:
      return "Feedback service is missing required headers (HTTP 412).";
    case 417:
      return "Feedback service rejected the request content type (HTTP 417).";
    case 500:
      return "Feedback service returned an internal error (HTTP 500). Please try again later.";
    default:
      return `Feedback service returned HTTP ${status}.`;
  }
}
