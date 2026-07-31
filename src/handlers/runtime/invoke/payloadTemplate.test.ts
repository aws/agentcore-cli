import { describe, expect, test } from "bun:test";
import { InputValidationError } from "../../../errors";
import {
  renderPayloadTemplate,
  summarizePayloadTemplate,
  supportsPayloadTemplate,
} from "./payloadTemplate";

describe("payload templates", () => {
  test.each([
    ["application/json", true],
    ["APPLICATION/JSON; charset=utf-8", true],
    ["application/problem+json", true],
    ["application/vnd.example+json; version=1", true],
    ["text/plain", false],
    ["application/x-ndjson", false],
    ["application/octet-stream", false],
    ["application/json-seq", false],
  ])("recognizes eligible content type %s", (contentType, expected) => {
    expect(supportsPayloadTemplate(contentType)).toBe(expected);
  });

  test("renders multiline JSON with embedded and repeated input markers", () => {
    const template = `{
  "prompt": "{{input}}",
  "messages": ["User request: {{input}}", "{{input}}"],
  "unchanged": 3
}`;

    expect(renderPayloadTemplate(template, 'hello "world"\nnext')).toBe(
      '{"prompt":"hello \\"world\\"\\nnext","messages":["User request: hello \\"world\\"\\nnext","hello \\"world\\"\\nnext"],"unchanged":3}',
    );
    expect(summarizePayloadTemplate(template)).toBe(
      '5-line template · {"prompt":"{{input}}","messages":["User request: {{input}}","{{input}}"],"unchanged":3}',
    );
  });

  test("rejects invalid JSON and templates without an input marker in a value", () => {
    expect(() => renderPayloadTemplate('{"prompt":', "hello")).toThrow(InputValidationError);
    expect(() => renderPayloadTemplate('{"prompt":"fixed"}', "hello")).toThrow(
      'Payload template must include "{{input}}" in a string value',
    );
    expect(() => renderPayloadTemplate('{"{{input}}":"fixed"}', "hello")).toThrow(
      'Payload template must include "{{input}}" in a string value',
    );
  });
});
