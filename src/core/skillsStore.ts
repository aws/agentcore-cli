import { createReadStream } from "node:fs";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import type { LocalObjectSource, SkillsStore } from "./project/backends/imperative/types";
import type { AwsClients } from "./types";

/** DeleteObjects accepts at most this many keys per call. */
export const DELETE_BATCH_SIZE = 1000;

/**
 * The S3-backed {@link SkillsStore}. Every object is written with a single
 * PutObject, so the ETag S3 reports is the content's MD5 and a sync can diff
 * local files against the bucket without downloading anything.
 */
export class S3SkillsStore implements SkillsStore {
  constructor(private readonly clients: Pick<AwsClients, "s3">) {}

  async bucketState(bucket: string, region: string): Promise<"present" | "absent" | "forbidden"> {
    try {
      await this.clients.s3({ region }).send(new HeadBucketCommand({ Bucket: bucket }));
      return "present";
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      const name = (error as Error).name;
      if (name === "NotFound" || name === "NoSuchBucket" || status === 404) return "absent";
      // HeadBucket answers 403 for a bucket that exists in another account.
      if (name === "Forbidden" || status === 403) return "forbidden";
      throw error;
    }
  }

  async createBucket(bucket: string, region: string): Promise<void> {
    const s3 = this.clients.s3({ region });
    try {
      await s3.send(
        new CreateBucketCommand({
          Bucket: bucket,
          // us-east-1 is the one region CreateBucket rejects as a constraint.
          ...(region !== "us-east-1" && {
            CreateBucketConfiguration: {
              LocationConstraint: region as BucketLocationConstraint,
            },
          }),
        }),
      );
    } catch (error) {
      if ((error as Error).name !== "BucketAlreadyOwnedByYou") throw error;
    }
    await s3.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
    );
  }

  async list(
    bucket: string,
    prefix: string,
    region: string,
  ): Promise<{ key: string; etag: string }[]> {
    const s3 = this.clients.s3({ region });
    const objects: { key: string; etag: string }[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        // ETags arrive quoted; a multipart ETag also carries a part-count suffix,
        // which never matches an MD5 and so reads as "changed" — the right answer
        // for an object something else uploaded.
        objects.push({ key: object.Key, etag: (object.ETag ?? "").replace(/"/g, "") });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  async put(bucket: string, key: string, body: LocalObjectSource, region: string): Promise<void> {
    await this.clients.s3({ region }).send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(body.absolutePath),
        ContentLength: body.size,
        ContentMD5: Buffer.from(body.md5, "hex").toString("base64"),
      }),
    );
  }

  async delete(bucket: string, keys: string[], region: string): Promise<void> {
    const s3 = this.clients.s3({ region });
    for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
      const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}
