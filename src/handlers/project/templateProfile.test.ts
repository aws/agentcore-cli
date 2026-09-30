import { describe, expect, test } from "bun:test";
import {
  RuntimeTemplateProfileSchema,
  templateManagesDependencies,
  templateUsesModel,
} from "./templateProfile";

describe("runtime template profiles", () => {
  test("templates use models and managed dependencies by default", () => {
    expect(templateUsesModel(undefined)).toBe(true);
    expect(templateManagesDependencies(undefined)).toBe(true);
    expect(templateUsesModel({})).toBe(true);
    expect(templateManagesDependencies({})).toBe(true);
  });

  test("accepts template-specific runtime and dependency behavior", () => {
    const profile = RuntimeTemplateProfileSchema.parse({
      usesModel: false,
      dependencySetup: "deferred",
      runtime: {
        entrypoint: "lifecycle/server.py",
        dockerfile: "Dockerfile",
        lifecycleConfiguration: {
          idleRuntimeSessionTimeout: 1800,
          maxLifetime: 28800,
        },
        additionalPolicies: ["runtime-policy.json"],
        tags: { "agentcore:template": "Example" },
      },
    });

    expect(templateUsesModel(profile)).toBe(false);
    expect(templateManagesDependencies(profile)).toBe(false);
  });

  test("rejects invalid runtime defaults", () => {
    expect(
      RuntimeTemplateProfileSchema.safeParse({
        runtime: {
          dockerfile: "../Dockerfile",
          lifecycleConfiguration: {
            idleRuntimeSessionTimeout: 3600,
            maxLifetime: 1800,
          },
        },
      }).success,
    ).toBe(false);
  });
});
