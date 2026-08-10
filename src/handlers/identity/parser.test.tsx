import { describe, expect, test } from "bun:test";
import { InputValidationError } from "../../errors";
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

  test("throws InputValidationError (not a generic error) on bad input", () => {
    expect(() => parseSecretReference(FLAG, "{not json}")).toThrow(InputValidationError);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseSecretReference(FLAG, "{not json}")).toThrow("Invalid JSON");
  });

  test("rejects non-object input", () => {
    expect(() => parseSecretReference(FLAG, '"just a string"')).toThrow(`--${FLAG}`);
  });

  test("rejects array input", () => {
    expect(() => parseSecretReference(FLAG, "[]")).toThrow(`--${FLAG}`);
  });

  test("rejects missing secretId", () => {
    expect(() => parseSecretReference(FLAG, '{"jsonKey":"apiKey"}')).toThrow(`--${FLAG}`);
  });

  test("rejects missing jsonKey", () => {
    expect(() =>
      parseSecretReference(FLAG, '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s"}'),
    ).toThrow(`--${FLAG}`);
  });

  test("rejects empty secretId", () => {
    expect(() => parseSecretReference(FLAG, '{"secretId":"","jsonKey":"apiKey"}')).toThrow(
      `--${FLAG}`,
    );
  });

  test("rejects empty jsonKey", () => {
    expect(() =>
      parseSecretReference(
        FLAG,
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":""}',
      ),
    ).toThrow(`--${FLAG}`);
  });

  test("rejects unexpected fields", () => {
    expect(() =>
      parseSecretReference(
        FLAG,
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":"apiKey","extra":"bad"}',
      ),
    ).toThrow(`--${FLAG}`);
  });

  test("rejects non-string secretId", () => {
    expect(() => parseSecretReference(FLAG, '{"secretId":123,"jsonKey":"apiKey"}')).toThrow(
      `--${FLAG}`,
    );
  });

  test("rejects non-string jsonKey", () => {
    expect(() =>
      parseSecretReference(
        FLAG,
        '{"secretId":"arn:aws:secretsmanager:us-west-2:123:secret:s","jsonKey":true}',
      ),
    ).toThrow(`--${FLAG}`);
  });

  test("includes flag name in error messages", () => {
    expect(() => parseSecretReference("my-flag", "{bad}")).toThrow("--my-flag");
  });
});
