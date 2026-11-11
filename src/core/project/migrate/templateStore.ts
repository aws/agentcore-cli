import { createHash } from "node:crypto";
import { DescribeStacksCommand, type CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { ProjectStateError } from "../../../errors";
import type { CdkCredentialProvider } from "../backends/cdk/toolkit";
import { isStackNotFound } from "../backends/cdk/environment";

/**
 * The largest template CloudFormation accepts inline (TemplateBody), in bytes.
 * Anything bigger has to be uploaded to S3 and passed as a TemplateURL.
 */
export const MAX_TEMPLATE_BODY_BYTES = 51_200;

/** Where a stack refactor or change set reads a template from: inline, or from S3. */
export type TemplateLocation = { TemplateBody: string } | { TemplateURL: string };

/** Holds templates too big to pass inline, for the length of one CloudFormation call. */
export type TemplateStore = {
  /** Uploads `body` and returns its URL. */
  put(key: string, body: string): Promise<string>;
  /** Deletes what `put` uploaded under `key`; never fails the migration. */
  remove(key: string): Promise<void>;
};

/** Builds the store for a region, once a template turns out to need one. */
export type TemplateStoreFactory = (region: string) => Promise<TemplateStore>;

/**
 * A template's location for a CloudFormation call: inline when it fits, otherwise
 * uploaded to the store under a key unique to its content. `release` deletes the
 * upload once CloudFormation has read it.
 */
export async function templateLocation(
  template: unknown,
  name: string,
  store: () => Promise<TemplateStore>,
): Promise<{ location: TemplateLocation; release(): Promise<void> }> {
  const body = JSON.stringify(template);
  if (Buffer.byteLength(body, "utf8") <= MAX_TEMPLATE_BODY_BYTES) {
    return { location: { TemplateBody: body }, release: async () => {} };
  }
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const key = `agentcore-migrate/${name}-${digest}.json`;
  const resolved = await store();
  const url = await resolved.put(key, body);
  return { location: { TemplateURL: url }, release: () => resolved.remove(key) };
}

const BOOTSTRAP_STACK_NAME = "CDKToolkit";
const BUCKET_OUTPUT = "BucketName";

/**
 * The CDK bootstrap bucket of the account and region `client` is for, read from
 * the bootstrap stack's outputs the way the CDK finds it. v0 deploys always
 * bootstrap, so a deployed project's region has one.
 */
export async function bootstrapBucket(client: CloudFormationClient): Promise<string> {
  let outputs;
  try {
    const response = await client.send(
      new DescribeStacksCommand({ StackName: BOOTSTRAP_STACK_NAME }),
    );
    outputs = response.Stacks?.[0]?.Outputs;
  } catch (error) {
    if (!isStackNotFound(error)) throw error;
  }
  const bucket = outputs?.find((output) => output.OutputKey === BUCKET_OUTPUT)?.OutputValue;
  if (!bucket) {
    throw new ProjectStateError(
      `A template is larger than CloudFormation's ${MAX_TEMPLATE_BODY_BYTES}-byte inline limit, ` +
        `so it has to be uploaded to the CDK bootstrap bucket, but the ${BOOTSTRAP_STACK_NAME} ` +
        `stack has no ${BUCKET_OUTPUT} output. Bootstrap the environment with ` +
        "`agentcore deploy`, then try again.",
    );
  }
  return bucket;
}

/**
 * A template store backed by the CDK bootstrap bucket of `region`. The S3 client is
 * loaded on first use, since most templates fit inline.
 */
export function bootstrapBucketStore(config: {
  cloudFormation: CloudFormationClient;
  credentials: CdkCredentialProvider;
  region: string;
}): TemplateStore {
  let ready: Promise<{ bucket: string; send: (command: unknown) => Promise<unknown> }> | undefined;
  const connect = () =>
    (ready ??= (async () => {
      const bucket = await bootstrapBucket(config.cloudFormation);
      const { S3Client } = await import("@aws-sdk/client-s3");
      const client = new S3Client({ credentials: config.credentials, region: config.region });
      return { bucket, send: (command: unknown) => client.send(command as never) };
    })());
  return {
    async put(key, body) {
      const { bucket, send } = await connect();
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      await send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
        }),
      );
      return templateUrl(bucket, config.region, key);
    },
    async remove(key) {
      try {
        const { bucket, send } = await connect();
        const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
        await send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch {
        // A leftover template in the bootstrap bucket is harmless (the CDK leaves
        // its own there too); failing the migration over it would not be.
      }
    },
  };
}

/**
 * The URL CloudFormation reads an uploaded template from. Path-style, as the CDK
 * uses for templates, so a bucket name with dots still matches the certificate;
 * China regions use their own domain.
 */
export function templateUrl(bucket: string, region: string, key: string): string {
  const domain = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://s3.${region}.${domain}/${bucket}/${key}`;
}
