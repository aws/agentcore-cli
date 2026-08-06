import { describe, expect, test } from "bun:test";
import type { DevLogLevel } from "../../handlers/project/dev/types";
import { ProcessSupervisor, windowsExecutable } from "./process";

function collect() {
  const logs: [DevLogLevel, string][] = [];
  return { logs, onLog: (level: DevLogLevel, message: string) => logs.push([level, message]) };
}

function supervisor() {
  return new ProcessSupervisor();
}

function nodeCommand(script: string) {
  return {
    executable: windowsExecutable("node", ".exe"),
    args: ["-e", script],
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  };
}

describe("ProcessSupervisor", () => {
  test("streams stdout lines and resolves exited after output flushes", async () => {
    const { logs, onLog } = collect();
    const handle = supervisor().spawn(nodeCommand("console.log('one'); console.log('two')"), onLog);

    expect(await handle.exited).toEqual({ kind: "exited", code: 0 });
    expect(logs).toEqual([
      ["info", "one"],
      ["info", "two"],
    ]);
  });

  test("classifies stderr lines by content", async () => {
    const { logs, onLog } = collect();
    const handle = supervisor().spawn(
      nodeCommand("console.error('ERROR: boom'); console.error('routine log')"),
      onLog,
    );

    await handle.exited;
    expect(logs).toContainEqual(["error", "ERROR: boom"]);
    expect(logs).toContainEqual(["info", "routine log"]);
  });

  test("stop() terminates a long-running process", async () => {
    const { onLog } = collect();
    const handle = supervisor().spawn(nodeCommand("setInterval(() => {}, 1000)"), onLog);

    const exit = await handle.stop();
    // Killed by signal on POSIX; on Windows, taskkill terminates with an exit code.
    expect(exit.kind === "signaled" || (exit.kind === "exited" && exit.code !== 0)).toBe(true);
  });

  test("resolves spawn-error when the executable does not exist", async () => {
    const { onLog } = collect();
    const handle = supervisor().spawn(
      {
        executable: "definitely-not-a-real-binary-xyz",
        args: [],
        cwd: process.cwd(),
        env: {},
      },
      onLog,
    );

    expect((await handle.exited).kind).toBe("spawn-error");
  });

  test("stop() is idempotent", async () => {
    const { onLog } = collect();
    const handle = supervisor().spawn(nodeCommand("setInterval(() => {}, 1000)"), onLog);

    const first = await handle.stop();
    const second = await handle.stop();
    expect(first).toEqual(second);
  });
});
