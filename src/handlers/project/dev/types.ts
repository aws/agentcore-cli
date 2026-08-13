import type { ProjectRuntime } from "../../../projectSchemas/runtime";

export type DevEvent =
  | { type: "status"; message: string }
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string };

export type DevServerInput = {
  runtime: ProjectRuntime;
  projectRoot: string;
  port: number;
  env?: Record<string, string>;
  signal: AbortSignal;
};

export interface DevRunner {
  run(input: DevServerInput): AsyncGenerator<DevEvent, void>;
}
