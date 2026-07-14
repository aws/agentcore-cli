import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json";

describe("reviewed package contract", () => {
  test("pins the release runtime and direct dependencies", async () => {
    expect(await Bun.file(".node-version").text()).toBe("22.22.1\n");
    expect(await Bun.file(".bun-version").text()).toBe("1.3.14\n");
    expect(packageJson.engines).toEqual({ node: ">=22.22.1" });
    expect(packageJson.packageManager).toBe("bun@1.3.14");
    expect(packageJson.files).toEqual(["dist", "THIRD_PARTY_NOTICES.md"]);
    expect("@inkui-cli/data-table" in packageJson.dependencies).toBe(false);
    expect(packageJson.dependencies["@aws-sdk/client-bedrock-agentcore-control"]).toBe("3.1079.0");
    expect(packageJson.dependencies["@aws-sdk/client-bedrock-agentcore"]).toBe("3.1079.0");
    expect(packageJson.dependencies["commander"]).toBe("15.0.0");
    expect(packageJson.dependencies["ink"]).toBe("7.1.0");
    expect(packageJson.dependencies["react"]).toBe("19.2.7");
    expect(packageJson.dependencies["@tanstack/react-query"]).toBe("5.101.2");
    expect(packageJson.dependencies["zod"]).toBe("4.4.3");
    expect(packageJson.dependencies["jsonc-parser"]).toBe("3.3.1");
    expect(packageJson.dependencies["@smithy/core"]).toBe("3.29.1");
  });
});
