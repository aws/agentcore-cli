import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InheritedProcessOptions, InheritedProcessRunner } from "./io";
import { runV0Compatibility, V0_CLI_PACKAGE, V0_CLI_VERSION } from "./v0Compatibility";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(version: unknown = 1): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-v0-compat-"));
  cleanups.push(root);
  await mkdir(join(root, "agentcore"));
  await writeFile(
    join(root, "agentcore", "agentcore.json"),
    JSON.stringify({ name: "example", version }),
  );
  return root;
}

function recordingRunner(exitCode = 0): {
  calls: Array<{ command: string[]; options: InheritedProcessOptions }>;
  runner: InheritedProcessRunner;
} {
  const calls: Array<{ command: string[]; options: InheritedProcessOptions }> = [];
  return {
    calls,
    runner: async (command, options) => {
      calls.push({ command, options });
      return exitCode;
    },
  };
}

describe("runV0Compatibility", () => {
  test.each(["dev", "d", "deploy", "dp", "invoke", "i", "status", "s", "logs", "l", "traces", "t"])(
    "delegates v0 project command %s with its arguments unchanged",
    async (command) => {
      const root = await project();
      const subject = recordingRunner(7);
      const env = { PATH: "/test/path", TEST_VALUE: "preserved" };

      const exitCode = await runV0Compatibility(
        ["node", "agentcore", command, "--unknown-to-v1", "value"],
        {
          cwd: root,
          env,
          isInteractive: false,
          runner: subject.runner,
        },
      );

      expect(exitCode).toBe(7);
      expect(subject.calls).toEqual([
        {
          command: ["npx", "--yes", V0_CLI_PACKAGE, command, "--unknown-to-v1", "value"],
          options: {
            cwd: root,
            env: {
              ...env,
              AGENTCORE_SKIP_CONFLICT_CHECK: "1",
            },
          },
        },
      ]);
    },
  );

  test("delegates a bare invocation to the v0 TUI", async () => {
    const root = await project();
    const subject = recordingRunner();

    await runV0Compatibility(["node", "agentcore"], {
      cwd: root,
      isInteractive: false,
      runner: subject.runner,
    });

    expect(subject.calls[0]?.command).toEqual(["npx", "--yes", V0_CLI_PACKAGE]);
  });

  test("runs the delegated CLI from the project root when invoked in a subdirectory", async () => {
    const root = await project();
    const nested = join(root, "src", "nested");
    await mkdir(nested, { recursive: true });
    const subject = recordingRunner();

    await runV0Compatibility(["node", "agentcore", "deploy"], {
      cwd: nested,
      isInteractive: false,
      runner: subject.runner,
    });

    expect(subject.calls[0]?.options.cwd).toBe(root);
  });

  test.each(["migrate", "add", "remove", "runtime", "gateway", "--help", "--version"])(
    "leaves %s on the v1 path",
    async (command) => {
      const root = await project();
      const subject = recordingRunner();

      const result = await runV0Compatibility(["node", "agentcore", command], {
        cwd: root,
        runner: subject.runner,
      });

      expect(result).toBeUndefined();
      expect(subject.calls).toEqual([]);
    },
  );

  test.each(["build", "export"])("blocks v1 %s for a v0 project", async (command) => {
    const root = await project();
    const subject = recordingRunner();

    await expect(
      runV0Compatibility(["node", "agentcore", command], {
        cwd: root,
        runner: subject.runner,
      }),
    ).rejects.toThrow(`Run \`agentcore migrate\` to use the v1 ${command} command.`);
    expect(subject.calls).toEqual([]);
  });

  test("does nothing outside a project or in a v1 project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agentcore-no-project-"));
    cleanups.push(outside);
    const v1 = await project(2);
    const subject = recordingRunner();

    expect(
      await runV0Compatibility(["node", "agentcore", "deploy"], {
        cwd: outside,
        runner: subject.runner,
      }),
    ).toBeUndefined();
    expect(
      await runV0Compatibility(["node", "agentcore", "deploy"], {
        cwd: v1,
        runner: subject.runner,
      }),
    ).toBeUndefined();
    expect(subject.calls).toEqual([]);
  });

  test("leaves malformed project files to v1 validation", async () => {
    const root = await project();
    await writeFile(join(root, "agentcore", "agentcore.json"), "{not json");
    const subject = recordingRunner();

    expect(
      await runV0Compatibility(["node", "agentcore", "deploy"], {
        cwd: root,
        runner: subject.runner,
      }),
    ).toBeUndefined();
    expect(subject.calls).toEqual([]);
  });

  test("prints compatibility guidance only for interactive non-JSON commands", async () => {
    const root = await project();
    const messages: string[] = [];
    const subject = recordingRunner();

    await runV0Compatibility(["node", "agentcore", "status"], {
      cwd: root,
      isInteractive: true,
      runner: subject.runner,
      writeStatus: (message) => messages.push(message),
    });
    await runV0Compatibility(["node", "agentcore", "status", "--json"], {
      cwd: root,
      isInteractive: true,
      runner: subject.runner,
      writeStatus: (message) => messages.push(message),
    });
    await runV0Compatibility(["node", "agentcore", "status"], {
      cwd: root,
      isInteractive: false,
      runner: subject.runner,
      writeStatus: (message) => messages.push(message),
    });

    expect(messages).toEqual([
      `This is a v0 project; running AgentCore CLI ${V0_CLI_VERSION} in compatibility mode. ` +
        "Run `agentcore migrate` to upgrade it to v1.\n",
    ]);
  });
});
