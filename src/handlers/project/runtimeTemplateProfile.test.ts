import { describe, expect, test } from "bun:test";
import { BMA_TEMPLATE_PROFILE } from "./bma";
import { resolveRuntimeTemplateProfile } from "./runtimeTemplateProfile";

describe("resolveRuntimeTemplateProfile", () => {
  test("derives the canonical BMA profile from the framework", () => {
    expect(
      resolveRuntimeTemplateProfile({
        framework: "bma",
      }),
    ).toBe(BMA_TEMPLATE_PROFILE);

    expect(
      resolveRuntimeTemplateProfile({
        framework: "bma",
        templateProfile: {
          usesModel: true,
          dependencySetup: "managed",
          runtime: { entrypoint: "main.py" },
        },
      }),
    ).toBe(BMA_TEMPLATE_PROFILE);
  });

  test("preserves caller-supplied profiles for other frameworks", () => {
    const profile = { usesModel: false } as const;
    expect(
      resolveRuntimeTemplateProfile({
        framework: "none",
        templateProfile: profile,
      }),
    ).toBe(profile);
  });
});
