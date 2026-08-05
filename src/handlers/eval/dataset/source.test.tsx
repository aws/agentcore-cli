import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceResolver } from "../../../io";
import { InputValidationError } from "../../../errors";
import { MAX_INLINE_EXAMPLES, looksLikePath, resolveDatasetSource } from "./source";

// The resolver only reads stdin when a value is exactly "-", which these tests
// never pass; a null stream stands in so nothing can accidentally block on it.
function resolver(): SourceResolver {
  return new SourceResolver({ stdin: null as unknown as NodeJS.ReadStream });
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function writeTempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-dataset-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

const EXAMPLE_A = { scenario_id: "shipped-order", turns: [{ input: "Where is order 12345?" }] };
const EXAMPLE_B = { scenario_id: "unknown-order", turns: [{ input: "Where is order 99999?" }] };

describe("resolveDatasetSource", () => {
  test("hands an s3:// URI to the service without reading it locally", async () => {
    const result = await resolveDatasetSource("s3://my-bucket/datasets/orders.jsonl", resolver());

    expect(result).toEqual({ s3Source: { s3Uri: "s3://my-bucket/datasets/orders.jsonl" } });
  });

  test("parses a file:// JSONL path into inline examples", async () => {
    const path = writeTempFile(
      "orders.jsonl",
      `${JSON.stringify(EXAMPLE_A)}\n${JSON.stringify(EXAMPLE_B)}\n`,
    );

    const result = await resolveDatasetSource(`file://${path}`, resolver());

    expect(result).toEqual({ inlineExamples: { examples: [EXAMPLE_A, EXAMPLE_B] } });
  });

  // A JSONL file conventionally ends with a newline; that trailing blank must not
  // become an empty example the service would reject.
  test("ignores blank lines, including a trailing newline", async () => {
    const path = writeTempFile(
      "orders.jsonl",
      `${JSON.stringify(EXAMPLE_A)}\n\n  \n${JSON.stringify(EXAMPLE_B)}\n`,
    );

    const result = await resolveDatasetSource(`file://${path}`, resolver());

    expect(result).toEqual({ inlineExamples: { examples: [EXAMPLE_A, EXAMPLE_B] } });
  });

  // JSONL is one object per line, not a JSON array: a pretty-printed array would
  // otherwise be silently accepted as garbage or rejected without explanation.
  test("reports the line number and an excerpt for a malformed line", async () => {
    const path = writeTempFile(
      "orders.jsonl",
      `${JSON.stringify(EXAMPLE_A)}\n{"scenario_id": "broken"\n${JSON.stringify(EXAMPLE_B)}\n`,
    );

    const promise = resolveDatasetSource(`file://${path}`, resolver());

    await expect(promise).rejects.toThrow(InputValidationError);
    await expect(promise).rejects.toThrow(/line 2/);
    await expect(promise).rejects.toThrow(/scenario_id/);
  });

  test("rejects a JSONL row that is not an object", async () => {
    const path = writeTempFile("array.jsonl", `${JSON.stringify([EXAMPLE_A])}\n`);

    const promise = resolveDatasetSource(`file://${path}`, resolver());

    await expect(promise).rejects.toThrow(InputValidationError);
    await expect(promise).rejects.toThrow(/expected a JSON object/);
  });

  test("rejects a source that yields no examples", async () => {
    const path = writeTempFile("empty.jsonl", "\n\n");

    const promise = resolveDatasetSource(`file://${path}`, resolver());

    await expect(promise).rejects.toThrow(InputValidationError);
    await expect(promise).rejects.toThrow(/at least one/);
  });

  // inlineExamples is capped per request, so an oversized file must fail loudly
  // rather than be truncated to the first MAX_INLINE_EXAMPLES scenarios.
  test("rejects more examples than one request allows, naming the S3 alternative", async () => {
    const lines = Array.from({ length: MAX_INLINE_EXAMPLES + 1 }, (_, i) =>
      JSON.stringify({ scenario_id: `s-${i}` }),
    ).join("\n");
    const path = writeTempFile("big.jsonl", lines);

    const promise = resolveDatasetSource(`file://${path}`, resolver());

    await expect(promise).rejects.toThrow(InputValidationError);
    await expect(promise).rejects.toThrow(new RegExp(`${MAX_INLINE_EXAMPLES + 1} examples`));
    await expect(promise).rejects.toThrow(/s3:\/\//);
  });

  test("surfaces a missing file rather than treating the path as content", async () => {
    const promise = resolveDatasetSource("file:///nonexistent/orders.jsonl", resolver());

    await expect(promise).rejects.toThrow(/orders\.jsonl/);
  });

  test("accepts inline JSONL content", async () => {
    const result = await resolveDatasetSource(JSON.stringify(EXAMPLE_A), resolver());

    expect(result).toEqual({ inlineExamples: { examples: [EXAMPLE_A] } });
  });
});

describe("looksLikePath", () => {
  test.each([
    ["./dataset/orders.jsonl", true],
    ["orders.jsonl", true],
    ["/abs/path/orders.json", true],
    ["~/orders.jsonl", true],
    ["file://./orders.jsonl", false],
    ["s3://bucket/orders.jsonl", false],
    ['{"scenario_id":"a"}', false],
    ['{"a":1}\n{"b":2}', false],
  ])("looksLikePath(%p) is %p", (value, expected) => {
    expect(looksLikePath(value)).toBe(expected);
  });
});
