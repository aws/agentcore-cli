import z from "zod";
import type { DataSourceType } from "@aws-sdk/client-bedrock-agentcore-control";
import { flag } from "../../../router";
import { InputValidationError } from "../../../errors";
import { parseJsonObjectLines, type SourceResolver } from "../../../io";

const S3_PREFIX = "s3://";
const FILE_PREFIX = "file://";

// The service accepts at most this many examples in one inlineExamples request.
// A larger file needs to be split across follow-up AddDatasetExamples calls,
// which dataset update owns; create rejects it rather than silently truncating.
export const MAX_INLINE_EXAMPLES = 1000;

export const sourceFlag = flag(
  "source",
  "dataset examples: a JSONL file (file://<path>), an S3 JSONL object (s3://<bucket>/<key>), " +
    "or - for stdin",
  z.string().optional(),
);

// resolveDatasetSource turns the single --source value into the API's
// DataSourceType union. An s3:// URI is handed to the service, which reads the
// object itself; anything else is resolved locally (file://<path>, - for stdin,
// or inline text) and parsed from JSONL into inline examples.
export async function resolveDatasetSource(
  value: string,
  source: SourceResolver,
): Promise<DataSourceType> {
  if (value.startsWith(S3_PREFIX)) return { s3Source: { s3Uri: value } };

  const raw = await source.resolveText("source", value);
  const examples = parseJsonObjectLines(raw ?? "", "'--source'").map(({ value }) => value);

  if (examples.length === 0) {
    throw new InputValidationError(
      `'--source' resolved to no examples; a dataset must be created with at least one`,
    );
  }
  if (examples.length > MAX_INLINE_EXAMPLES) {
    throw new InputValidationError(
      `'--source' contains ${examples.length} examples, above the service limit of ` +
        `${MAX_INLINE_EXAMPLES} per request; split the file or stage it in S3 and pass an s3:// URI`,
    );
  }

  return { inlineExamples: { examples } };
}

// looksLikePath reports whether a --source value that failed to resolve as JSONL
// was probably meant as a file path. `file://` is the documented spelling and a
// bare path is the predictable first mistake, so it is worth naming rather than
// surfacing as a JSON parse error on line 1.
export function looksLikePath(value: string): boolean {
  if (value.startsWith(FILE_PREFIX) || value.startsWith(S3_PREFIX)) return false;
  if (value.includes("\n")) return false;
  return /^[.~/]|\.jsonl?$/i.test(value.trim());
}
