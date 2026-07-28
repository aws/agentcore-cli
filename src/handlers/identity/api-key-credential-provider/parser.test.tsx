import { describe, expect, test } from "bun:test";
import { parseSecretReference } from "./parser";

describe("parseSecretReference", () => {
  test("parses a valid secret reference", () => {
    const result = parseSecretReference(
      '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:my-secret","jsonKey":"apiKey"}',
    );
    expect(result).toEqual({
      secretId: "arn:aws:secretsmanager:us-west-2:123:secret:my-secret",
      jsonKey: "apiKey",
    });
  });

  test("rejects invalid JSON", () => {
    expect(() => parseSecretReference("{not json}")).toThrow("Invalid JSON");
  });

  test("rejects non-object input", () => {
    expect(() => parseSecretReference('"just a string"')).toThrow("must be a JSON object");
  });

  test("rejects array input", () => {
    expect(() => parseSecretReference("[]")).toThrow("must be a JSON object");
  });

  test("rejects missing secretId", () => {
    expect(() => parseSecretReference('{"jsonKey":"apiKey"}')).toThrow('non-empty "secretId"');
  });

  test("rejects missing jsonKey", () => {
    expect(() =>
      parseSecretReference('{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s"}'),
    ).toThrow('non-empty "jsonKey"');
  });

  test("rejects empty secretId", () => {
    expect(() => parseSecretReference('{"secretId":"","jsonKey":"apiKey"}')).toThrow(
      'non-empty "secretId"',
    );
  });

  test("rejects empty jsonKey", () => {
    expect(() =>
      parseSecretReference(
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":""}',
      ),
    ).toThrow('non-empty "jsonKey"');
  });

  test("rejects unexpected fields", () => {
    expect(() =>
      parseSecretReference(
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"apiKey","extra":"bad"}',
      ),
    ).toThrow("unexpected fields: extra");
  });

  test("rejects non-string secretId", () => {
    expect(() => parseSecretReference('{"secretId":123,"jsonKey":"apiKey"}')).toThrow(
      'non-empty "secretId"',
    );
  });

  test("rejects non-string jsonKey", () => {
    expect(() =>
      parseSecretReference(
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":true}',
      ),
    ).toThrow('non-empty "jsonKey"');
  });
});
