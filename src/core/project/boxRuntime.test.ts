import { describe, expect, test } from "bun:test";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import { BOX_RUNTIME_CONFIG, boxRuntimeMounts, renderBoxRuntimeConfig } from "./boxRuntime";

function runtime(overrides: Partial<ProjectRuntime> = {}): ProjectRuntime {
  return {
    name: "storage-agent",
    build: "CodeZip",
    entrypoint: "start.py",
    codeLocation: "app/agent",
    ...overrides,
  } as unknown as ProjectRuntime;
}

describe("Box Runtime mount requirements", () => {
  test("leaves a runtime without storage on the existing startup path", () => {
    expect(boxRuntimeMounts(runtime())).toEqual([]);
    expect(boxRuntimeMounts(runtime({ filesystemConfigurations: [] }))).toEqual([]);
    expect(boxRuntimeMounts(runtime({ protocol: "MCP" }))).toEqual([]);
  });

  test.each([
    { sessionStorage: { mountPath: "/mnt/session" } },
    { efsAccessPoint: { accessPointArn: "test-efs-access-point", mountPath: "/mnt/shared" } },
    {
      s3FilesAccessPoint: {
        accessPointArn: "test-s3-files-access-point",
        mountPath: "/mnt/datasets",
      },
    },
  ])("requires the configured filesystem rather than its placeholder directory: %j", (mount) => {
    const requirements = boxRuntimeMounts(runtime({ filesystemConfigurations: [mount] }));
    const configuration = Object.values(mount)[0]!;
    expect(requirements).toEqual([
      { path: configuration.mountPath, filesystem_types: ["nfs", "nfs4"] },
    ]);
  });

  test("normalizes trailing slashes without granting parent directories", () => {
    expect(
      boxRuntimeMounts(
        runtime({
          filesystemConfigurations: [
            { sessionStorage: { mountPath: "/mnt/session/" } },
            {
              efsAccessPoint: {
                accessPointArn: "test-efs-access-point",
                mountPath: "/mnt/shared/",
              },
            },
            {
              s3FilesAccessPoint: {
                accessPointArn: "test-s3-files-access-point",
                mountPath: "/mnt/shared",
              },
            },
          ],
        }),
      ),
    ).toEqual([
      { path: "/mnt/session", filesystem_types: ["nfs", "nfs4"] },
      { path: "/mnt/shared", filesystem_types: ["nfs", "nfs4"] },
    ]);
  });

  test.each([
    "/mnt/.",
    "/mnt/../",
    "/mnt/..",
    "/mnt/data/../other",
    "/mnt/data/nested",
    "/mnt//data",
    "/mnt/data//",
    "/tmp/data",
    "/mnt",
    "/mnt/",
    "/",
  ])("rejects an unsafe storage path before generating access: %s", (mountPath) => {
    const storageRuntime = runtime({
      filesystemConfigurations: [{ sessionStorage: { mountPath } }],
    });
    expect(() => boxRuntimeMounts(storageRuntime)).toThrow('runtime "storage-agent"');
    expect(() => boxRuntimeMounts(storageRuntime)).toThrow("directly below /mnt");
    expect(() => renderBoxRuntimeConfig(storageRuntime)).toThrow(
      "dot and parent-directory segments",
    );
  });

  test.each(["MCP", "A2A"] as const)("rejects storage for unsupported protocol %s", (protocol) => {
    expect(() =>
      boxRuntimeMounts(
        runtime({
          protocol,
          filesystemConfigurations: [{ sessionStorage: { mountPath: "/mnt/session" } }],
        }),
      ),
    ).toThrow('runtime "storage-agent": deferred Box startup with storage supports HTTP only');
  });

  test("writes the launcher metadata contract to runtime-start.json", () => {
    expect(BOX_RUNTIME_CONFIG).toBe("runtime-start.json");
    const text = renderBoxRuntimeConfig(
      runtime({ filesystemConfigurations: [{ sessionStorage: { mountPath: "/mnt/session/" } }] }),
    );
    expect(JSON.parse(text)).toEqual({
      version: 1,
      required_mounts: [{ path: "/mnt/session", filesystem_types: ["nfs", "nfs4"] }],
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(renderBoxRuntimeConfig(runtime()))).toEqual({
      version: 1,
      required_mounts: [],
    });
  });
});
