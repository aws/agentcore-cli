import { describe, expect, test } from "bun:test";
import {
  credentialProviderTypeFromArn,
  parseArn,
  regionFromArn,
  resourceNameFromArn,
  serviceIdFromArn,
} from "./arn";

const PREFIX = "arn:aws:bedrock-agentcore:us-west-2:123456789012";
const API_KEY_ARN = `${PREFIX}:token-vault/default/apikeycredentialprovider/openai-key`;
const OAUTH2_ARN = `${PREFIX}:token-vault/default/oauth2credentialprovider/github-oauth`;

describe("parseArn", () => {
  test("splits an ARN into its fields", () => {
    expect(parseArn(`${PREFIX}:memory/recall-AbC123`)).toEqual({
      partition: "aws",
      service: "bedrock-agentcore",
      region: "us-west-2",
      account: "123456789012",
      resource: "memory/recall-AbC123",
    });
  });

  test("keeps colons inside the resource part", () => {
    expect(parseArn("arn:aws:lambda:us-east-1:123456789012:function:name:1")?.resource).toBe(
      "function:name:1",
    );
  });

  test("returns undefined for a non-ARN", () => {
    expect(parseArn("recall-AbC123")).toBeUndefined();
    expect(parseArn("")).toBeUndefined();
  });
});

describe("serviceIdFromArn", () => {
  test("returns the memory id", () => {
    expect(serviceIdFromArn(`${PREFIX}:memory/recall-AbC123`)).toBe("recall-AbC123");
  });

  test("returns the gateway id", () => {
    expect(serviceIdFromArn(`${PREFIX}:gateway/tools-GwId12345`)).toBe("tools-GwId12345");
  });

  test("returns the runtime id", () => {
    expect(serviceIdFromArn(`${PREFIX}:runtime/harness_support-AbCdEf1234`)).toBe(
      "harness_support-AbCdEf1234",
    );
  });

  test("returns the id of an AWS-managed default resource", () => {
    expect(serviceIdFromArn("arn:aws:bedrock-agentcore:us-east-1:aws:browser/aws.browser.v1")).toBe(
      "aws.browser.v1",
    );
  });

  test("returns the whole path under the type for a credential provider", () => {
    expect(serviceIdFromArn(API_KEY_ARN)).toBe("default/apikeycredentialprovider/openai-key");
  });

  test("passes a non-ARN through unchanged", () => {
    expect(serviceIdFromArn("TARGETID123")).toBe("TARGETID123");
  });

  test("passes an ARN without a resource path through unchanged", () => {
    expect(serviceIdFromArn("arn:aws:iam::123456789012:root")).toBe(
      "arn:aws:iam::123456789012:root",
    );
  });
});

describe("resourceNameFromArn", () => {
  test("returns the trailing name of an API key credential provider", () => {
    expect(resourceNameFromArn(API_KEY_ARN)).toBe("openai-key");
  });

  test("returns the trailing name of an OAuth2 credential provider", () => {
    expect(resourceNameFromArn(OAUTH2_ARN)).toBe("github-oauth");
  });

  test("is the service id for single-segment resources", () => {
    expect(resourceNameFromArn(`${PREFIX}:memory/recall-AbC123`)).toBe("recall-AbC123");
  });

  test("passes a non-ARN through unchanged", () => {
    expect(resourceNameFromArn("openai-key")).toBe("openai-key");
  });
});

describe("regionFromArn", () => {
  test("reads the region", () => {
    expect(regionFromArn(`${PREFIX}:runtime/harness_support-AbCdEf1234`)).toBe("us-west-2");
  });

  test("is undefined for a global ARN", () => {
    expect(regionFromArn("arn:aws:iam::123456789012:role/MyRole")).toBeUndefined();
  });

  test("is undefined for a non-ARN", () => {
    expect(regionFromArn("recall-AbC123")).toBeUndefined();
  });
});

describe("credentialProviderTypeFromArn", () => {
  test("recognises an API key provider", () => {
    expect(credentialProviderTypeFromArn(API_KEY_ARN)).toBe("api-key");
  });

  test("recognises an OAuth2 provider", () => {
    expect(credentialProviderTypeFromArn(OAUTH2_ARN)).toBe("oauth2");
  });

  test("is undefined for other token-vault resources", () => {
    expect(credentialProviderTypeFromArn(`${PREFIX}:token-vault/default`)).toBeUndefined();
  });

  test("is undefined for other resources and non-ARNs", () => {
    expect(credentialProviderTypeFromArn(`${PREFIX}:memory/recall-AbC123`)).toBeUndefined();
    expect(credentialProviderTypeFromArn("openai-key")).toBeUndefined();
  });
});
