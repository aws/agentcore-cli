import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceResolver } from "../../../../io";
import { testIO } from "../../../../testing";
import { ratingScaleFromPreset } from "../../ratingScale";
import { buildEvaluatorModelConfig, resolveRatingScale } from "./sharedFlags";

// resolveRatingScale is the only branching logic behind --rating-scale: a value is
// either a known preset id or a source-aware JSON RatingScale. These cases never
// reach the SDK, so they are covered here rather than in the fixture-backed
// handler tests.
function sourceWith(stdin?: string): SourceResolver {
  const io = testIO();
  if (stdin !== undefined) {
    io.io.stdin.push(stdin);
    io.io.stdin.push(null);
  }
  return new SourceResolver({ stdin: io.io.stdin });
}

describe("resolveRatingScale", () => {
  test("returns undefined when the flag is omitted", async () => {
    expect(await resolveRatingScale(undefined, sourceWith())).toBeUndefined();
  });

  test("expands a preset id", async () => {
    expect(await resolveRatingScale("1-5-quality", sourceWith())).toEqual(
      ratingScaleFromPreset("1-5-quality"),
    );
  });

  test("parses an inline custom JSON rating scale", async () => {
    const scale = { numerical: [{ value: 1, label: "L", definition: "d" }] };
    expect(await resolveRatingScale(JSON.stringify(scale), sourceWith())).toEqual(scale);
  });

  test("reads a custom rating scale from a file:// path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-rating-scale-"));
    const file = join(dir, "scale.json");
    const scale = { categorical: [{ label: "P", definition: "pass" }] };
    writeFileSync(file, JSON.stringify(scale));
    try {
      expect(await resolveRatingScale(`file://${file}`, sourceWith())).toEqual(scale);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads a custom rating scale from stdin with `-`", async () => {
    const scale = { categorical: [{ label: "F", definition: "fail" }] };
    expect(await resolveRatingScale("-", sourceWith(JSON.stringify(scale)))).toEqual(scale);
  });

  test("rejects malformed JSON", async () => {
    await expect(resolveRatingScale("{not json", sourceWith())).rejects.toThrow(
      /Invalid JSON for option '--rating-scale'/,
    );
  });
});

describe("buildEvaluatorModelConfig", () => {
  test("Bedrock selects the bedrock arm with only the model id", () => {
    expect(
      buildEvaluatorModelConfig("Bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
    ).toEqual({
      bedrockEvaluatorModelConfig: { modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" },
    });
  });

  test("OpenResponses selects the responses arm with the deployment defaults and no topP", () => {
    const config = buildEvaluatorModelConfig("OpenResponses", "openai.gpt-5.4");
    expect(config).toEqual({
      responsesEvaluatorModelConfig: {
        modelId: "openai.gpt-5.4",
        maxOutputTokens: 4096,
        temperature: 0,
      },
    });
    expect("bedrockEvaluatorModelConfig" in config).toBe(false);
    expect(
      (config as { responsesEvaluatorModelConfig: { topP?: number } }).responsesEvaluatorModelConfig
        .topP,
    ).toBeUndefined();
  });
});
