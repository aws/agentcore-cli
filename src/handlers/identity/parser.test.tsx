import { describe, expect, test } from "bun:test";
import { parseSecretReference } from "./parser";

const FLAG = "test-secret-reference";

describe("parseSecretReference", () => {
  test("parses a valid secret reference", () => {
    const result = parseSecretReference(
      FLAG,
      '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:my-secret","jsonKey":"apiKey"}',
    );
    expect(result).toEqual({
      secretId: "arn:aws:secretsmanager:us-west-2:123:secret:my-secret",
      jsonKey: "apiKey",
    });
  });

  test("rejects invalid JSON", () => {
    expect(() => parseSecretReference(FLAG, "{not json}")).toThrow("Invalid JSON");
  });

  test("rejects non-object input", () => {
    expect(() => parseSecretReference(FLAG, '"just a string"')).toThrow("must be a JSON object");
  });

  test("rejects array input", () => {
    expect(() => parseSecretReference(FLAG, "[]")).toThrow("must be a JSON object");
  });

  test("rejects missing secretId", () => {
    expect(() => parseSecretReference(FLAG, '{"jsonKey":"apiKey"}')).toThrow(
      'non-empty "secretId"',
    );
  });

  test("rejects missing jsonKey", () => {
    expect(() =>
      parseSecretReference(FLAG, '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s"}'),
    ).toThrow('non-empty "jsonKey"');
  });

  test("rejects empty secretId", () => {
    expect(() => parseSecretReference(FLAG, '{"secretId":"","jsonKey":"apiKey"}')).toThrow(
      'non-empty "secretId"',
    );
  });

  test("rejects empty jsonKey", () => {
    expect(() =>
      parseSecretReference(
        FLAG,
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":""}',
      ),
    ).toThrow('non-empty "jsonKey"');
  });

  test("rejects unexpected fields", () => {
    expect(() =>
      parseSecretReference(
        FLAG,
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"apiKey","extra":"bad"}',
      ),
    ).toThrow("unexpected fields: extra");
  });

  test("rejects non-string secretId", () => {
    expect(() => parseSecretReference(FLAG, '{"secretId":123,"jsonKey":"apiKey"}')).toThrow(
      'non-empty "secretId"',
    );
  });

  test("rejects non-string jsonKey", () => {
    expect(() =>
      parseSecretReference(
        FLAG,
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":true}',
      ),
    ).toThrow('non-empty "jsonKey"');
  });

  test("includes flag name in error messages", () => {
    expect(() => parseSecretReference("my-flag", "{bad}")).toThrow("--my-flag");
  });
});
