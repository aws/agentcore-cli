import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { BOX_CONTAINER_START, BOX_RUNTIME_MODULE } from "../boxRuntime";
import { FsAssetSource, type AssetSource } from "../source";
import { assertBoxStorageLauncher, stageBoxRuntimeAssets } from "./boxRuntimeAssets";

const directories: string[] = [];
const source = new FsAssetSource(join(import.meta.dir, "..", "..", "..", "assets"));
const CONTAINER_ENTRYPOINT =
  'ENTRYPOINT ["/usr/local/bin/python", "/home/bedrock_agentcore/box-profile/box_container_start.py"]';
const CONTAINER_COPY =
  "COPY --chown=bedrock_agentcore:bedrock_agentcore ${BOX_DIST}/ /home/bedrock_agentcore/box-profile/";

function runtime(build: "CodeZip" | "Container", storage = true): ProjectRuntime {
  return {
    name: "storage-agent",
    build,
    entrypoint: build === "CodeZip" ? "start.py" : "main.py",
    codeLocation: "app/agent",
    ...(storage && {
      filesystemConfigurations: [{ sessionStorage: { mountPath: "/mnt/session" } }],
    }),
  } as unknown as ProjectRuntime;
}

async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "box-runtime-assets-"));
  directories.push(directory);
  return directory;
}

async function launcher(name: string, text: string): Promise<string> {
  const path = join(await temp(), name);
  await writeFile(path, text);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Box Runtime launcher asset staging", () => {
  test.each([false, true])("ships the helper files needed by container=%s", async (container) => {
    const folder = await temp();
    await stageBoxRuntimeAssets(folder, container, source);
    const expected = container ? [BOX_RUNTIME_MODULE, BOX_CONTAINER_START] : [BOX_RUNTIME_MODULE];
    expect((await readdir(folder)).sort()).toEqual([...expected].sort());
    for (const name of expected) {
      expect(await readFile(join(folder, name), "utf8")).toBe(
        await source.read(`templates/box-codezip/${name}`),
      );
    }
  });

  test("leaves the folder untouched when a required packaged asset cannot be loaded", async () => {
    const folder = await temp();
    const brokenSource: AssetSource = {
      read: async (name) => {
        if (name.endsWith(BOX_CONTAINER_START)) throw new Error("container launcher asset missing");
        return "helper module";
      },
      list: async () => [],
    };
    await expect(stageBoxRuntimeAssets(folder, true, brokenSource)).rejects.toThrow(
      "container launcher asset missing",
    );
    expect(await readdir(folder)).toEqual([]);
  });
});

describe("Box storage launcher compatibility", () => {
  test("does not inspect or replace startup files when no storage is configured", async () => {
    const unusedSource: AssetSource = {
      read: mock(async () => {
        throw new Error("unexpected asset read");
      }),
      list: async () => [],
    };
    for (const build of ["CodeZip", "Container"] as const) {
      await assertBoxStorageLauncher(
        runtime(build, false),
        join(await temp(), "missing"),
        unusedSource,
      );
    }
    expect(unusedSource.read).not.toHaveBeenCalled();
  });

  test.each(["CodeZip", "Container"] as const)(
    "reports a missing %s launcher with an upgrade path",
    async (build) => {
      const path = join(await temp(), build === "CodeZip" ? "start.py" : "Dockerfile");
      await expect(assertBoxStorageLauncher(runtime(build), path, source)).rejects.toThrow(
        'runtime "storage-agent"',
      );
      await expect(assertBoxStorageLauncher(runtime(build), path, source)).rejects.toThrow(path);
      await expect(assertBoxStorageLauncher(runtime(build), path, source)).rejects.toThrow(
        "Create a temporary project",
      );
    },
  );

  test("accepts the generated CodeZip launcher with trailing blank lines", async () => {
    const text = await source.read("templates/box-codezip/start.py");
    const path = await launcher("start.py", `${text.trimEnd()}\n\n`);
    await assertBoxStorageLauncher(runtime("CodeZip"), path, source);
  });

  test.each([
    'import os\nos.execve("box", ["box", "run", "profile.toml"], os.environ)\n',
    '# from box_runtime import serve\n# serve(command, configuration["required_mounts"])\nimport os\nos.execve("box", ["box"], os.environ)\n',
  ])("rejects eager and comment-spoofed CodeZip launchers without changing them", async (text) => {
    const path = await launcher("start.py", text);
    await expect(assertBoxStorageLauncher(runtime("CodeZip"), path, source)).rejects.toThrow(
      "Storage requires the generated deferred launcher",
    );
    expect(await readFile(path, "utf8")).toBe(text);
  });

  test("preserves a customized CodeZip launcher for explicit migration", async () => {
    const text = `${await source.read("templates/box-codezip/start.py")}\nprint("custom startup")\n`;
    const path = await launcher("start.py", text);
    await expect(assertBoxStorageLauncher(runtime("CodeZip"), path, source)).rejects.toThrow(
      "customized",
    );
    expect(await readFile(path, "utf8")).toBe(text);
  });

  test("accepts the generated container with unrelated dependency instructions", async () => {
    const text = `${await source.read("templates/agent-python-strands-box/Dockerfile.template")}\nCOPY requirements-extra.txt /tmp/requirements-extra.txt\nRUN echo dependencies-installed\n`;
    const path = await launcher("Dockerfile", text);
    await assertBoxStorageLauncher(runtime("Container"), path, source);
  });

  test("permits an unrelated stage copy when the generated helpers come from the local context", async () => {
    const template = await source.read("templates/agent-python-strands-box/Dockerfile.template");
    const text = `FROM python:3.12-slim AS dependencies\nRUN mkdir -p /opt/dependency\n${template}\nCOPY --from=dependencies /opt/dependency/ /opt/dependency/\n`;
    const path = await launcher("Dockerfile", text);
    await assertBoxStorageLauncher(runtime("Container"), path, source);
  });

  test.each([
    [
      "eager entrypoint",
      (text: string) =>
        text.replace(CONTAINER_ENTRYPOINT, 'ENTRYPOINT ["/opt/box/box", "run", "profile.toml"]'),
    ],
    [
      "comment-only wrapper",
      (text: string) =>
        text.replace(
          CONTAINER_ENTRYPOINT,
          `# ${CONTAINER_ENTRYPOINT}\nENTRYPOINT ["/opt/box/box", "run", "profile.toml"]`,
        ),
    ],
    [
      "overridden final entrypoint",
      (text: string) => `${text}\nENTRYPOINT ["/opt/box/box", "run", "profile.toml"]\n`,
    ],
    [
      "new final stage without wrapper",
      (text: string) => `${text}\nFROM python:3.12-slim\nCMD ["python", "main.py"]\n`,
    ],
    [
      "wrong helper copy destination",
      (text: string) => text.replace(CONTAINER_COPY, "COPY ${BOX_DIST}/ /opt/wrong-profile/"),
    ],
    [
      "profile-only copy",
      (text: string) =>
        text.replace(
          CONTAINER_COPY,
          "COPY ${BOX_DIST}/profile.toml /home/bedrock_agentcore/box-profile/",
        ),
    ],
    [
      "helpers copied from another stage",
      (text: string) =>
        `FROM python:3.12-slim AS builder\nRUN mkdir -p /.box-dist\n${text.replace(
          CONTAINER_COPY,
          "COPY --from=builder .box-dist/ /home/bedrock_agentcore/box-profile/",
        )}`,
    ],
    [
      "a generated helper excluded from the copy",
      (text: string) =>
        text.replace(
          CONTAINER_COPY,
          "COPY --exclude=box_runtime.py ${BOX_DIST}/ /home/bedrock_agentcore/box-profile/",
        ),
    ],
    [
      "malformed entrypoint JSON",
      (text: string) => text.replace(CONTAINER_ENTRYPOINT, 'ENTRYPOINT ["/usr/local/bin/python",]'),
    ],
  ] as const)("rejects a container with %s", async (_name, transform) => {
    const text = transform(
      await source.read("templates/agent-python-strands-box/Dockerfile.template"),
    );
    const path = await launcher("Dockerfile", text);
    await expect(assertBoxStorageLauncher(runtime("Container"), path, source)).rejects.toThrow(
      "Storage requires the generated deferred launcher",
    );
    expect(await readFile(path, "utf8")).toBe(text);
  });
});
