import { describe, expect, test } from "bun:test";
import { HarnessModelProviderSchema, harnessModelIdHelp } from "./harness";
import { MODEL_DOCS_URLS, modelIdHelp } from "./modelDocs";

describe("model ID docs links", () => {
  test("every harness provider has a model ID link", () => {
    for (const provider of HarnessModelProviderSchema.options) {
      expect(MODEL_DOCS_URLS[provider]).toStartWith("https://");
      expect(harnessModelIdHelp(provider, "the model to use")).toBe(
        `the model to use\nmodel IDs: ${MODEL_DOCS_URLS[provider]}`,
      );
    }
  });

  test("every link fits on one line in an 80-column terminal", () => {
    // Ink wraps on word boundaries, so a URL that fits the line stays intact
    // even when the "model IDs:" label pushes it down; one that doesn't fit is
    // split mid-URL and stops being clickable.
    for (const url of Object.values(MODEL_DOCS_URLS)) {
      expect(url.length).toBeLessThanOrEqual(78);
    }
  });

  test("help text keeps what to enter on the first line", () => {
    expect(modelIdHelp("anthropic", "a Claude model ID").split("\n")[0]).toBe("a Claude model ID");
  });
});
