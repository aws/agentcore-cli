import { resolve } from "node:path";

export function resolveTraceOutputPath(config: {
  output?: string;
  traceId: string;
  cwd?: string;
}): string {
  const cwd = config.cwd ?? process.cwd();
  if (config.output) return resolve(cwd, config.output);
  return resolve(cwd, `${config.traceId}.json`);
}
