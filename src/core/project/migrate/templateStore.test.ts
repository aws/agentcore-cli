import { describe, expect, test } from "bun:test";
import { ProjectStateError } from "../../../errors";
import { fakeCloudFormation, fakeTemplateStore } from "./migrate-test-support";
import {
  bootstrapBucket,
  MAX_TEMPLATE_BODY_BYTES,
  templateLocation,
  templateUrl,
} from "./templateStore";

describe("templateLocation", () => {
  test("passes a template inline up to the limit, and uploads a bigger one", async () => {
    const store = fakeTemplateStore();
    const small = await templateLocation({ Resources: {} }, "S", async () => store);
    expect(small.location).toEqual({ TemplateBody: '{"Resources":{}}' });

    // Exactly at the limit still fits.
    const padding = MAX_TEMPLATE_BODY_BYTES - JSON.stringify({ p: "" }).length;
    const atLimit = await templateLocation({ p: "x".repeat(padding) }, "S", async () => store);
    expect("TemplateBody" in atLimit.location).toBe(true);

    const big = await templateLocation({ p: "x".repeat(padding + 1) }, "S", async () => store);
    expect(big.location).toEqual({ TemplateURL: `https://bootstrap.example/${store.puts[0]}` });
    await big.release();
    expect(store.removed).toEqual(store.puts);
  });
});

describe("bootstrapBucket", () => {
  test("reads the bucket from the CDKToolkit stack's outputs", async () => {
    const cloudFormation = fakeCloudFormation(
      {},
      { bootstrapBucket: "cdk-hnb659fds-assets-1-us-east-1" },
    );
    expect(await bootstrapBucket(cloudFormation.create({ region: "us-east-1" } as never))).toBe(
      "cdk-hnb659fds-assets-1-us-east-1",
    );
  });

  test("explains what to do when there's no bootstrap stack", async () => {
    const cloudFormation = fakeCloudFormation({});
    const read = bootstrapBucket(cloudFormation.create({ region: "us-east-1" } as never));
    await expect(read).rejects.toBeInstanceOf(ProjectStateError);
    await expect(
      bootstrapBucket(cloudFormation.create({ region: "us-east-1" } as never)),
    ).rejects.toThrow("the CDKToolkit stack has no BucketName output");
  });
});

describe("templateUrl", () => {
  test("is path-style, in the region's partition", () => {
    expect(
      templateUrl("cdk-hnb659fds-assets-1-us-east-1", "us-east-1", "agentcore-migrate/S-1.json"),
    ).toBe(
      "https://s3.us-east-1.amazonaws.com/cdk-hnb659fds-assets-1-us-east-1/agentcore-migrate/S-1.json",
    );
    expect(templateUrl("b.with.dots", "cn-north-1", "k.json")).toBe(
      "https://s3.cn-north-1.amazonaws.com.cn/b.with.dots/k.json",
    );
  });
});
