import { readFile } from "node:fs/promises";

export type ReadTextFileOptions = {
  signal?: AbortSignal;
};

export async function readTextFile(
  path: string,
  options: ReadTextFileOptions = {},
): Promise<string> {
  return readFile(path, { encoding: "utf8", signal: options.signal });
}
