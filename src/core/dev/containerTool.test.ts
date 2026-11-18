import { describe, expect, test } from "bun:test";
import { resolveCdkDockerExecutable, resolveContainerTool } from "./containerTool";

function available(installed: Record<string, { build: boolean }>) {
  const probes: string[] = [];
  const check = async (tool: string, args: string[] = ["--version"]) => {
    probes.push(`${tool} ${args.join(" ")}`);
    const entry = installed[tool];
    if (!entry) return false;
    return args[0] === "build" ? entry.build : true;
  };
  return { check, probes };
}

describe("resolveContainerTool", () => {
  test("prefers docker, then podman, then finch", async () => {
    expect(await resolveContainerTool(available({ docker: { build: true } }).check)).toBe("docker");
    expect(
      await resolveContainerTool(
        available({ podman: { build: true }, finch: { build: true } }).check,
      ),
    ).toBe("podman");
    expect(await resolveContainerTool(available({ finch: { build: true } }).check)).toBe("finch");
  });

  test("explains an uninitialized Finch VM and a missing runtime", async () => {
    await expect(
      resolveContainerTool(available({ finch: { build: false } }).check),
    ).rejects.toThrow("finch vm init");
    await expect(resolveContainerTool(available({}).check)).rejects.toThrow("Install Docker");
  });
});

describe("resolveCdkDockerExecutable", () => {
  test("honors an explicit CDK_DOCKER without probing", async () => {
    const { check, probes } = available({ docker: { build: true } });
    expect(await resolveCdkDockerExecutable({ CDK_DOCKER: "/opt/bin/nerdctl" }, check)).toBe(
      "/opt/bin/nerdctl",
    );
    expect(probes).toEqual([]);
  });

  test("detects the builder when CDK_DOCKER is unset", async () => {
    const { check } = available({ finch: { build: true } });
    expect(await resolveCdkDockerExecutable({}, check)).toBe("finch");
  });
});
