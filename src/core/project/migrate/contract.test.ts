import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { v0Fixture } from "../legacy/fixtures-test-support";
import { convertSpec } from "./convertSpec";
import { maxprojDeployedState } from "./migrate-test-support";

/**
 * The migratedFrom contract with `@aws/agentcore-cdk`: the physical name every
 * deployed resource of the `maxproj` v0 fixture keeps, by `<resource type> <name>`.
 * The same golden file is asserted in the library
 * (test/project/migrated-from-contract.test.ts), which synthesizes the converted
 * project (physical-names-contract.agentcore.json, copied there verbatim as
 * converted.json, with `migratedFrom: "v1"`) and requires the template to give each
 * resource exactly that name. Change both together.
 */
const GOLDEN_SPEC = JSON.parse(
  readFileSync(
    join(import.meta.dir, "__fixtures__", "physical-names-contract.agentcore.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const GOLDEN = JSON.parse(
  readFileSync(
    join(import.meta.dir, "__fixtures__", "physical-names-contract.golden.json"),
    "utf8",
  ),
) as { project: string; migratedFrom: string; names: Record<string, string> };

describe("migratedFrom contract with @aws/agentcore-cdk", () => {
  test("the golden files are the ones the library asserts, byte for byte", () => {
    // The same hashes are asserted in the library's test/project/migrated-from-contract.test.ts.
    const sha256 = (name: string) =>
      createHash("sha256")
        .update(readFileSync(join(import.meta.dir, "__fixtures__", name)))
        .digest("hex");
    expect(sha256("physical-names-contract.golden.json")).toBe(
      "2dac5fc18e6893f04276cddab70ad50cd739968f6af25a314b34e8e5b7d5168c",
    );
    expect(sha256("physical-names-contract.agentcore.json")).toBe(
      "1bd381c22d9919ecb7e7ee7be6f59dbb4d3013a6c0ce8e8282b2e12d46e3f761",
    );
  });

  test("migrate keeps the golden names for the maxproj fixture and marks it migratedFrom", () => {
    const { json, pins, problems } = convertSpec(
      v0Fixture("top-mcpRuntimeTools.json"),
      maxprojDeployedState(),
      {
        // A Dockerfile harness the v0 app built (v0.16.0 and later).
        h1: { dockerfile: "Dockerfile", hasDockerfile: true, codeLocation: "app/h1" },
      },
    );
    expect(problems).toEqual([]);
    expect(GOLDEN.project).toBe("maxproj");
    expect(GOLDEN.migratedFrom).toBe("v1");
    expect(
      Object.fromEntries(pins.map((pin) => [`${pin.resourceType} ${pin.name}`, pin.value])),
    ).toEqual(GOLDEN.names);
    expect(json).toEqual(GOLDEN_SPEC);
    expect(json.migratedFrom).toBe("v1");
  });
});
