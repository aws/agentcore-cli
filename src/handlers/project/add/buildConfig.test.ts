import { describe, expect, test } from "bun:test";
import {
  buildConfigFlag,
  HarnessBuildConfigSchema,
  parseBuildConfig,
  RuntimeBuildConfigSchema,
} from "./buildConfig";

describe("--build-config", () => {
  test("help states how dockerfile paths resolve with and without buildContextPath", () => {
    expect(buildConfigFlag("Container or ContainerLocal").description).toContain(
      "Without buildContextPath, dockerfile is a path relative to the current directory, " +
        "copied once to app/<name>/Dockerfile (app/<name>/ is the build context). With " +
        "buildContextPath (relative to the project root), dockerfile is relative to that build " +
        "context and used in place.",
    );
  });

  test.each([RuntimeBuildConfigSchema, HarnessBuildConfigSchema])(
    "prefixes its schema errors with the option name",
    (schema) => {
      expect(() =>
        parseBuildConfig(
          JSON.stringify({ build: "ContainerLocal", buildContextPath: "/abs", dockerfile: "D" }),
          schema,
        ),
      ).toThrow(
        "Invalid value for option '--build-config': buildContextPath must be relative to the " +
          "project root, not an absolute path",
      );
      expect(() =>
        parseBuildConfig(
          JSON.stringify({
            build: "ContainerLocal",
            buildContextPath: "ctx",
            dockerfile: "/ctx/D",
          }),
          schema,
        ),
      ).toThrow(
        "Invalid value for option '--build-config': with buildContextPath, dockerfile must be " +
          "relative to that build context",
      );
    },
  );

  test("applies the CodeBuild reserved build-arg rule to Container only", () => {
    const args = { AWS_REGION: "us-west-2", CODEBUILD_SRC: "x", PATH: "/bin" };
    for (const schema of [RuntimeBuildConfigSchema, HarnessBuildConfigSchema]) {
      expect(
        schema.safeParse({ build: "ContainerLocal", dockerfile: "D", customDockerBuildArgs: args })
          .success,
      ).toBe(true);
      expect(
        schema.safeParse({ build: "Container", dockerfile: "D", customDockerBuildArgs: args })
          .success,
      ).toBe(false);
    }
    // A Harness with a Dockerfile and no build builds as Container.
    expect(
      HarnessBuildConfigSchema.safeParse({ dockerfile: "D", customDockerBuildArgs: args }).success,
    ).toBe(false);
  });
});
