import { describe, expect, test } from "bun:test";
import type { InheritedProcessOptions, InheritedProcessRunner } from "../../../io";
import { executeV0Deploy, V0_CLI_PACKAGE } from "./deploy";

describe("executeV0Deploy", () => {
  test("uses the latest v0 CLI and forwards deploy flags from the project root", async () => {
    const calls: Array<{ command: string[]; options: InheritedProcessOptions }> = [];
    const runner: InheritedProcessRunner = async (command, options) => {
      calls.push({ command, options });
      return 7;
    };

    const exitCode = await executeV0Deploy(
      {
        projectRoot: "/workspace/project",
        target: "staging",
        region: "eu-west-1",
        yes: true,
        json: true,
      },
      runner,
    );

    expect(exitCode).toBe(7);
    expect(calls).toEqual([
      {
        command: [
          "npx",
          "--yes",
          V0_CLI_PACKAGE,
          "deploy",
          "--target",
          "staging",
          "--yes",
          "--json",
        ],
        options: {
          cwd: "/workspace/project",
          env: {
            ...process.env,
            AGENTCORE_SKIP_CONFLICT_CHECK: "1",
            AWS_REGION: "eu-west-1",
          },
        },
      },
    ]);
  });

  test("omits optional flags when they were not requested", async () => {
    const commands: string[][] = [];
    await executeV0Deploy(
      {
        projectRoot: "/workspace/project",
        target: "default",
        region: "us-east-1",
        yes: false,
        json: false,
      },
      async (command) => {
        commands.push(command);
        return 0;
      },
    );

    expect(commands).toEqual([["npx", "--yes", V0_CLI_PACKAGE, "deploy", "--target", "default"]]);
  });
});
