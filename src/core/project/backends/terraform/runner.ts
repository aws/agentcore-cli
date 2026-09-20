import { streamProcess, type ProcessStreamer } from "../../../../io";
import type { ProjectEvent } from "../../../../handlers/project/types";

/** Keeps JSON stdout separate from diagnostics; commands never pass through a shell. */
export class TerraformRunner {
  constructor(private readonly stream: ProcessStreamer = streamProcess) {}

  async *run(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): AsyncGenerator<ProjectEvent, void> {
    for await (const event of this.stream(["terraform", ...args], { cwd, env })) {
      yield { type: "output", line: event.line };
    }
  }

  async json(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<unknown> {
    const stdout: string[] = [];
    for await (const event of this.stream(["terraform", ...args], { cwd, env })) {
      if (event.type === "stdout") stdout.push(event.line);
    }
    return JSON.parse(stdout.join("\n")) as unknown;
  }
}
