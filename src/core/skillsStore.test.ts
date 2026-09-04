import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { DELETE_BATCH_SIZE, S3SkillsStore } from "./skillsStore";

type Sent = { name: string; input: Record<string, unknown> };

/**
 * A fake S3 at the `.send()` seam. `respond` maps a command name to its
 * response (or throws), and every command is recorded for assertions.
 */
function fakeS3(respond: (name: string, input: Record<string, unknown>) => unknown) {
  const sent: Sent[] = [];
  const regions: string[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      return respond(command.constructor.name, command.input);
    },
  } as unknown as S3Client;
  const store = new S3SkillsStore({
    s3: ({ region }) => {
      regions.push(region);
      return client;
    },
  });
  return { store, sent, regions };
}

function s3Error(name: string, status?: number): Error {
  const error = new Error(name) as Error & { $metadata?: { httpStatusCode?: number } };
  error.name = name;
  if (status) error.$metadata = { httpStatusCode: status };
  return error;
}

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("S3SkillsStore.bucketState", () => {
  test("reports a bucket HeadBucket accepts as present", async () => {
    const { store, sent, regions } = fakeS3(() => ({}));
    expect(await store.bucketState("bkt", "eu-west-1")).toBe("present");
    expect(sent).toEqual([{ name: "HeadBucketCommand", input: { Bucket: "bkt" } }]);
    expect(regions).toEqual(["eu-west-1"]);
  });

  test.each([
    ["a NotFound error", s3Error("NotFound", 404)],
    ["a NoSuchBucket error", s3Error("NoSuchBucket")],
    ["a bare 404", s3Error("UnknownError", 404)],
  ])("reports %s as absent", async (_label, error) => {
    const { store } = fakeS3(() => {
      throw error;
    });
    expect(await store.bucketState("bkt", "us-east-1")).toBe("absent");
  });

  test.each([
    ["a Forbidden error", s3Error("Forbidden", 403)],
    ["a bare 403", s3Error("UnknownError", 403)],
  ])("reports %s as forbidden", async (_label, error) => {
    const { store } = fakeS3(() => {
      throw error;
    });
    expect(await store.bucketState("bkt", "us-east-1")).toBe("forbidden");
  });

  test("rethrows anything else", async () => {
    const { store } = fakeS3(() => {
      throw s3Error("ServiceUnavailable", 503);
    });
    await expect(store.bucketState("bkt", "us-east-1")).rejects.toThrow("ServiceUnavailable");
  });
});

describe("S3SkillsStore.createBucket", () => {
  test("creates without a location constraint in us-east-1 and blocks public access", async () => {
    const { store, sent } = fakeS3(() => ({}));

    await store.createBucket("bkt", "us-east-1");

    expect(sent).toEqual([
      { name: "CreateBucketCommand", input: { Bucket: "bkt" } },
      {
        name: "PutPublicAccessBlockCommand",
        input: {
          Bucket: "bkt",
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        },
      },
    ]);
  });

  test("passes the region as the location constraint elsewhere", async () => {
    const { store, sent } = fakeS3(() => ({}));

    await store.createBucket("bkt", "eu-west-1");

    expect(sent[0]).toEqual({
      name: "CreateBucketCommand",
      input: { Bucket: "bkt", CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } },
    });
  });

  test("treats BucketAlreadyOwnedByYou as success and still blocks public access", async () => {
    const { store, sent } = fakeS3((name) => {
      if (name === "CreateBucketCommand") throw s3Error("BucketAlreadyOwnedByYou", 409);
      return {};
    });

    await store.createBucket("bkt", "us-east-1");

    expect(sent.map((s) => s.name)).toEqual(["CreateBucketCommand", "PutPublicAccessBlockCommand"]);
  });

  test("rethrows other creation failures", async () => {
    const { store } = fakeS3(() => {
      throw s3Error("BucketAlreadyExists", 409);
    });
    await expect(store.createBucket("bkt", "us-east-1")).rejects.toThrow("BucketAlreadyExists");
  });
});

describe("S3SkillsStore.list", () => {
  test("pages through ListObjectsV2 and strips ETag quotes", async () => {
    const { store, sent } = fakeS3((_name, input) =>
      input.ContinuationToken === undefined
        ? {
            Contents: [
              { Key: "p/a", ETag: '"aaa"' },
              { Key: "p/b", ETag: '"bbb-2"' },
            ],
            IsTruncated: true,
            NextContinuationToken: "t2",
          }
        : { Contents: [{ Key: "p/c", ETag: '"ccc"' }, { ETag: '"no-key"' }], IsTruncated: false },
    );

    const objects = await store.list("bkt", "p/", "us-east-1");

    expect(objects).toEqual([
      { key: "p/a", etag: "aaa" },
      { key: "p/b", etag: "bbb-2" },
      { key: "p/c", etag: "ccc" },
    ]);
    expect(sent.map((s) => s.input)).toEqual([
      { Bucket: "bkt", Prefix: "p/", ContinuationToken: undefined },
      { Bucket: "bkt", Prefix: "p/", ContinuationToken: "t2" },
    ]);
  });

  test("an empty prefix lists nothing", async () => {
    const { store } = fakeS3(() => ({}));
    expect(await store.list("bkt", "p/", "us-east-1")).toEqual([]);
  });
});

describe("S3SkillsStore.put", () => {
  test("streams the file with its length and base64 MD5", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentcore-skills-store-"));
    tempDirectories.push(dir);
    const path = join(dir, "SKILL.md");
    await writeFile(path, "hello");
    const { store, sent } = fakeS3(() => ({}));

    await store.put(
      "bkt",
      "p/SKILL.md",
      { absolutePath: path, size: 5, md5: "5d41402abc4b2a76b9719d911017c592" },
      "us-east-1",
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("PutObjectCommand");
    expect(sent[0]?.input).toMatchObject({
      Bucket: "bkt",
      Key: "p/SKILL.md",
      ContentLength: 5,
      ContentMD5: "XUFAKrxLKna5cZ2REBfFkg==",
    });
    // A stream, not the file's bytes.
    expect(typeof (sent[0]!.input.Body as { pipe?: unknown }).pipe).toBe("function");
  });
});

describe("S3SkillsStore.delete", () => {
  test("deletes in quiet batches of at most 1000 keys", async () => {
    const { store, sent } = fakeS3(() => ({}));
    const keys = Array.from({ length: DELETE_BATCH_SIZE * 2 + 5 }, (_, i) => `p/${i}`);

    await store.delete("bkt", keys, "us-east-1");

    expect(sent.map((s) => s.name)).toEqual([
      "DeleteObjectsCommand",
      "DeleteObjectsCommand",
      "DeleteObjectsCommand",
    ]);
    const sizes = sent.map(
      (s) => (s.input.Delete as { Objects: unknown[]; Quiet: boolean }).Objects.length,
    );
    expect(sizes).toEqual([DELETE_BATCH_SIZE, DELETE_BATCH_SIZE, 5]);
    expect((sent[0]!.input.Delete as { Quiet: boolean }).Quiet).toBe(true);
    expect((sent[2]!.input.Delete as { Objects: { Key: string }[] }).Objects[4]).toEqual({
      Key: "p/2004",
    });
  });

  test("issues nothing for an empty key list", async () => {
    const { store, sent } = fakeS3(() => ({}));
    await store.delete("bkt", [], "us-east-1");
    expect(sent).toEqual([]);
  });
});
