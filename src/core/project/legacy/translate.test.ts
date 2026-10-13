import { describe, expect, test } from "bun:test";
import { v0Fixture, validV0FixtureNames, rawFixture } from "./fixtures-test-support";
import { translateV0Spec } from "./translate";

type Json = Record<string, unknown>;

describe("translateV0Spec", () => {
  test("sets version 2 and drops $schema", () => {
    const { spec } = translateV0Spec(v0Fixture("baseline.json"));
    expect(spec.version).toBe(2);
    expect("$schema" in spec).toBe(false);
  });

  test("moves v0-only collections into extras and drops httpGateways", () => {
    const { spec, extras } = translateV0Spec(v0Fixture("top-abTests-nonempty.json"));
    for (const key of ["abTests", "datasets", "capacityProviders", "httpGateways"]) {
      expect(key in spec).toBe(false);
    }
    expect(extras.abTests?.length).toBeGreaterThan(0);

    const unassigned = translateV0Spec(v0Fixture("top-unassignedTargets.json"));
    expect("unassignedTargets" in unassigned.spec).toBe(false);
    expect(unassigned.extras.unassignedTargets?.length).toBeGreaterThan(0);
  });

  test("renames mcpRuntimeTools to toolRuntimes and artifact to build", () => {
    const { spec } = translateV0Spec(v0Fixture("top-mcpRuntimeTools.json"));
    expect("mcpRuntimeTools" in spec).toBe(false);
    const runtime = spec.toolRuntimes?.[0]?.compute.runtime as Json | undefined;
    expect(runtime?.build).toBe("CodeZip");
    expect(runtime?.artifact).toBeUndefined();
  });

  test("omits toolRuntimes when v0 had no mcpRuntimeTools", () => {
    const { spec } = translateV0Spec(v0Fixture("baseline.json"));
    expect("toolRuntimes" in spec).toBe(false);
  });

  test("renames artifact to build on gateway target compute", () => {
    const { spec } = translateV0Spec(
      v0Fixture("gateway-target-mcpServer-agentcoreRuntime-compute.json"),
    );
    const runtime = spec.agentCoreGateways
      .flatMap((gateway) => gateway.targets)
      .map((t) => t.compute)
      .flatMap((compute) => (compute?.host === "AgentCoreRuntime" ? [compute.runtime] : []))
      .find(Boolean) as Json | undefined;
    expect(runtime?.build).toBe("CodeZip");
    expect(runtime?.artifact).toBeUndefined();
  });

  test("drops capacityProviderVolume mounts but keeps the others", () => {
    const v0 = v0Fixture("runtime-capacityProviderVolume-mount.json");
    const before = v0.runtimes.flatMap((r) => r.filesystemConfigurations ?? []);
    const { spec } = translateV0Spec(v0);
    const after = spec.runtimes.flatMap((r) => r.filesystemConfigurations ?? []);
    expect(before.some((m) => "capacityProviderVolume" in m)).toBe(true);
    expect(after.some((m) => "capacityProviderVolume" in m)).toBe(false);
    expect(after.length).toBe(before.filter((m) => !("capacityProviderVolume" in m)).length);
  });

  test("is pure: does not mutate the input", () => {
    const v0 = v0Fixture("baseline.json");
    const before = JSON.stringify(v0);
    translateV0Spec(v0);
    expect(JSON.stringify(v0)).toBe(before);
  });

  test("translates every v0-valid fixture, keeping the project name", () => {
    for (const name of validV0FixtureNames()) {
      const { spec } = translateV0Spec(v0Fixture(name));
      expect({ name, project: spec.name }).toEqual({
        name,
        project: String(rawFixture(name).name),
      });
    }
  });
});
